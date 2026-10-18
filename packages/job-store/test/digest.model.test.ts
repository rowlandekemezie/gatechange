import { describe, expect, it } from "@effect/vitest";
import {
  AccountId,
  AlertStore,
  DAY_MILLIS,
  DigestMailer,
  DigestMailerUnavailable,
  JobStore,
  MAX_SAVED_SEARCHES,
  periodStartOf,
  runDigests,
  SourceName,
  SourceTerms,
  WEEK_MILLIS,
} from "@rat-stack/core";
import type {
  AccountIdValue,
  Digest,
  DigestPlan,
  JobValue,
  SearchFiltersValue,
} from "@rat-stack/core";
import { Array, Effect, Layer, Option, pipe, Predicate, Schema } from "effect";

import { alertStoreLayer, SqlExecutor, statement } from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const MONDAY = periodStartOf(1_760_000_000_000);

const NOW = MONDAY + 2 * DAY_MILLIS;

const HOUR = 3_600_000;

const PLAN: DigestPlan = { dailySendLimit: 1000, sendsPerRun: 1000 };

const accountId = (id: string) => AccountId.make(id);

const ada = accountId("user_ada");

const bob = accountId("user_bob");

const cy = accountId("user_cy");

const everywhere: SearchFiltersValue = {
  regions: ["RemoteCanada", "RemoteNorthAmerica", "RemoteGlobal"],
  roles: ["EngineeringManager", "Director"],
  search: "",
};

const job = (
  overrides: Partial<JobValue> & Pick<JobValue, "id" | "feed">
): JobValue => ({
  arrangement: "Remote",
  company: "Acme",
  firstSeenAt: NOW - DAY_MILLIS,
  lastSeenAt: NOW - DAY_MILLIS,
  location: "Remote - Canada",
  postedAt: NOW - DAY_MILLIS,
  region: "RemoteCanada",
  relevance: 50,
  role: "EngineeringManager",
  salary: null,
  source: "Jobicy",
  title: "Engineering Manager",
  url: "https://jobs.example/1",
  ...overrides,
});

type MailerMode = "Up" | "Down" | "QuotaExhausted";

const makeOutbox = () => {
  const sent: Digest[] = [];
  let current: MailerMode = "Up";

  const layer = Layer.succeed(
    DigestMailer,
    DigestMailer.of({
      send: (digest) =>
        Effect.suspend(() => {
          if (current === "Up") {
            sent.push(digest);

            return Effect.void;
          }

          return Effect.fail(
            new DigestMailerUnavailable({
              message: "mailer down",
              quotaExhausted: current === "QuotaExhausted",
            })
          );
        }),
    })
  );

  const setMode = (next: MailerMode) => {
    current = next;
  };

  return { layer, sent, setMode };
};

const withStores = <A, E>(
  body: Effect.Effect<A, E, AlertStore | JobStore | SqlExecutor>
) =>
  Effect.gen(function* provideStores() {
    const base = yield* sqlJsJobStore;

    return yield* body.pipe(
      Effect.provide(alertStoreLayer.pipe(Layer.provideMerge(base)))
    );
  });

const addMember = (id: AccountIdValue, verified = true) =>
  SqlExecutor.use((sql) =>
    sql.batch("addMember", [
      statement(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, id, `${id}@example.com`, verified ? 1 : 0, NOW, NOW]
      ),
    ])
  );

const saveSearch = (owner: AccountIdValue, filters = everywhere) =>
  AlertStore.use((store) =>
    store.saveSearch(owner, filters, NOW - 3 * DAY_MILLIS, MAX_SAVED_SEARCHES)
  );

const listJobs = (jobs: readonly JobValue[]) =>
  JobStore.use((store) =>
    Effect.forEach(
      Object.values(Array.groupBy(jobs, (listed) => listed.feed)),
      (group) => store.replaceFeed(group[0].feed, group, NOW - DAY_MILLIS),
      { discard: true }
    )
  );

const runAt = (now: number, mailer: Layer.Layer<DigestMailer>) =>
  runDigests(PLAN, now).pipe(Effect.provide(mailer));

const recipients = (sent: readonly Digest[]) =>
  sent.map((digest) => digest.account).toSorted();

describe("weekly saved-search digests", () => {
  it.effect(
    "running the digest job twice for the same window sends each member at most one email",
    () =>
      withStores(
        Effect.gen(function* twice() {
          const outbox = makeOutbox();

          yield* Effect.forEach([ada, bob, cy], (id) => addMember(id), {
            discard: true,
          });
          yield* saveSearch(ada);
          yield* saveSearch(bob);
          yield* saveSearch(cy, { ...everywhere, search: "Platform" });
          yield* listJobs([job({ feed: "greenhouse:acme", id: "gh:1" })]);

          const first = yield* runAt(NOW, outbox.layer);
          const second = yield* runAt(NOW, outbox.layer);
          const later = yield* runAt(NOW + 3 * HOUR, outbox.layer);

          expect(recipients(outbox.sent)).toEqual([ada, bob]);
          expect(first.sent).toBe(2);
          expect(first.empty).toBe(1);
          expect([second.sent, later.sent]).toEqual([0, 0]);
        })
      )
  );

  it.effect(
    "concurrent runs and random mailer outages never send a member two digests in one week",
    () =>
      withStores(
        Effect.gen(function* model() {
          const outbox = makeOutbox();

          const members = Array.makeBy(12, (index) =>
            accountId(`user_${index}`)
          );

          yield* Effect.forEach(members, (id) => addMember(id), {
            discard: true,
          });
          yield* Effect.forEach(members, (id) => saveSearch(id), {
            discard: true,
          });
          yield* listJobs([job({ feed: "greenhouse:acme", id: "gh:1" })]);

          const base = yield* AlertStore;

          const racing = AlertStore.of({
            ...base,
            dueRecipients: (periodStart, now) =>
              base
                .dueRecipients(periodStart, now)
                .pipe(Effect.tap(() => Effect.yieldNow)),
          });

          const racingRunAt = (at: number) =>
            runDigests(PLAN, at).pipe(
              Effect.provide(outbox.layer),
              Effect.provideService(AlertStore, racing)
            );

          const modes: readonly MailerMode[] = [
            "Down",
            "Up",
            "QuotaExhausted",
            "Up",
            "Down",
            "Up",
          ];

          yield* Effect.forEach(
            modes,
            (mode, step) =>
              Effect.sync(() => {
                outbox.setMode(mode);
              }).pipe(
                Effect.andThen(
                  Effect.all(
                    [
                      racingRunAt(NOW + step * HOUR),
                      racingRunAt(NOW + step * HOUR),
                    ],
                    { concurrency: 2 }
                  )
                )
              ),
            { discard: true }
          );

          expect(recipients(outbox.sent)).toEqual(members.toSorted());
        })
      )
  );

  it.effect(
    "only sources whose email alert terms are Allowed appear in a digest",
    () =>
      withStores(
        Effect.gen(function* terms() {
          const outbox = makeOutbox();

          yield* addMember(ada);
          yield* saveSearch(ada);
          yield* listJobs(
            SourceName.literals.map((source, index) =>
              job({
                company: `Company ${index}`,
                feed: `${source.toLowerCase()}:all`,
                id: `${source}:1`,
                source,
              })
            )
          );
          yield* runAt(NOW, outbox.layer);

          expect(
            pipe(
              outbox.sent,
              Array.flatMap((digest) => digest.jobs),
              Array.map((listed) => listed.source)
            ).toSorted()
          ).toEqual(
            SourceName.literals
              .filter((source) =>
                Predicate.isTagged(SourceTerms[source].emailAlerts, "Allowed")
              )
              .toSorted()
          );
        })
      )
  );

  it.effect("a company board role with Unstated terms never appears", () =>
    withStores(
      Effect.gen(function* board() {
        const outbox = makeOutbox();

        yield* addMember(ada);
        yield* saveSearch(ada);
        yield* listJobs([
          job({ feed: "greenhouse:acme", id: "gh:1", source: "Greenhouse" }),
          job({ feed: "lever:acme", id: "lever:1", source: "Lever" }),
          job({ feed: "ashby:acme", id: "ashby:1", source: "Ashby" }),
        ]);

        const receipt = yield* runAt(NOW, outbox.layer);

        expect(outbox.sent).toEqual([]);
        expect(receipt.empty).toBe(1);
      })
    )
  );

  it.effect("an Allowed source's role appears", () =>
    withStores(
      Effect.gen(function* allowed() {
        const outbox = makeOutbox();

        yield* addMember(ada);
        yield* saveSearch(ada);
        yield* listJobs([
          job({ feed: "jobicy:all", id: "jobicy:1", source: "Jobicy" }),
        ]);
        yield* runAt(NOW, outbox.layer);

        expect(outbox.sent[0]?.jobs.map((listed) => listed.id)).toEqual([
          "jobicy:1",
        ]);
      })
    )
  );

  it.effect(
    "an empty week sends and claims nothing, so a later week can send",
    () =>
      withStores(
        Effect.gen(function* emptyWeek() {
          const outbox = makeOutbox();

          yield* addMember(ada);
          yield* saveSearch(ada);
          yield* listJobs([
            job({ feed: "greenhouse:acme", id: "gh:1", source: "Greenhouse" }),
          ]);

          const empty = yield* runAt(NOW, outbox.layer);

          const claims = yield* SqlExecutor.use((sql) =>
            sql.all(
              "claims",
              statement(`SELECT account_id FROM alert_sends`),
              Schema.Struct({ account_id: Schema.String })
            )
          );

          yield* JobStore.use((store) =>
            store.replaceFeed(
              "jobicy:all",
              [
                job({
                  feed: "jobicy:all",
                  firstSeenAt: NOW + DAY_MILLIS,
                  id: "jobicy:1",
                  lastSeenAt: NOW + DAY_MILLIS,
                }),
              ],
              NOW + DAY_MILLIS
            )
          );

          const later = yield* runAt(NOW + 2 * DAY_MILLIS, outbox.layer);

          expect([empty.sent, empty.empty, claims.length]).toEqual([0, 1, 0]);
          expect(later.sent).toBe(1);
          expect(outbox.sent.map((digest) => digest.account)).toEqual([ada]);
        })
      )
  );

  it.effect(
    "the next week's digest lists only roles first seen since the last send",
    () =>
      withStores(
        Effect.gen(function* nextWeek() {
          const outbox = makeOutbox();

          yield* addMember(ada);
          yield* saveSearch(ada);
          yield* listJobs([job({ feed: "greenhouse:acme", id: "gh:1" })]);
          yield* runAt(NOW, outbox.layer);
          yield* JobStore.use((store) =>
            store.replaceFeed(
              "greenhouse:acme",
              [
                job({
                  feed: "greenhouse:acme",
                  id: "gh:1",
                  lastSeenAt: NOW + DAY_MILLIS,
                }),
                job({
                  feed: "greenhouse:acme",
                  firstSeenAt: NOW + DAY_MILLIS,
                  id: "gh:2",
                  lastSeenAt: NOW + DAY_MILLIS,
                  title: "Director of Engineering",
                }),
              ],
              NOW + DAY_MILLIS
            )
          );
          yield* runAt(NOW + WEEK_MILLIS, outbox.layer);

          expect(
            outbox.sent.map((digest) => digest.jobs.map((listed) => listed.id))
          ).toEqual([["gh:1"], ["gh:2"]]);
        })
      )
  );

  it.effect(
    "a member's first digest lists only roles first seen in the last seven days",
    () =>
      withStores(
        Effect.gen(function* firstWindow() {
          const outbox = makeOutbox();

          yield* addMember(ada);
          yield* saveSearch(ada);
          yield* listJobs([
            job({ feed: "greenhouse:acme", id: "gh:recent" }),
            job({
              feed: "greenhouse:acme",
              firstSeenAt: NOW - 8 * DAY_MILLIS,
              id: "gh:old",
              title: "Director of Engineering",
            }),
          ]);
          yield* runAt(NOW, outbox.layer);

          expect(
            outbox.sent.map((digest) => digest.jobs.map((listed) => listed.id))
          ).toEqual([["gh:recent"]]);
        })
      )
  );

  it.effect(
    "unsubscribed, unverified, search-less and match-less members get nothing",
    () =>
      withStores(
        Effect.gen(function* nobody() {
          const outbox = makeOutbox();
          const dan = accountId("user_dan");

          yield* addMember(ada);
          yield* addMember(bob, false);
          yield* addMember(cy);
          yield* addMember(dan);
          yield* saveSearch(ada);
          yield* saveSearch(bob);
          yield* saveSearch(dan, { ...everywhere, roles: ["VicePresident"] });
          yield* AlertStore.use((store) => store.unsubscribe(ada, NOW));
          yield* listJobs([job({ feed: "greenhouse:acme", id: "gh:1" })]);

          const receipt = yield* runAt(NOW, outbox.layer);

          expect(outbox.sent).toEqual([]);
          expect(receipt.due).toBe(1);
          expect(receipt.empty).toBe(1);
        })
      )
  );

  it.effect("deleting a saved search stops its digests", () =>
    withStores(
      Effect.gen(function* deleted() {
        const outbox = makeOutbox();

        yield* addMember(ada);

        const saved = yield* saveSearch(ada);

        yield* listJobs([job({ feed: "greenhouse:acme", id: "gh:1" })]);
        yield* AlertStore.use((store) =>
          Option.match(saved, {
            onNone: () => Effect.void,
            onSome: (search) => store.deleteSearch(ada, search.id),
          })
        );
        yield* runAt(NOW, outbox.layer);

        expect(outbox.sent).toEqual([]);
      })
    )
  );

  it.effect(
    "a failed send is not recorded, so the next run retries it once",
    () =>
      withStores(
        Effect.gen(function* retriesNextRun() {
          const outbox = makeOutbox();

          yield* addMember(ada);
          yield* saveSearch(ada);
          yield* listJobs([job({ feed: "greenhouse:acme", id: "gh:1" })]);
          outbox.setMode("Down");

          const failed = yield* runAt(NOW, outbox.layer);

          outbox.setMode("Up");

          const retried = yield* runAt(NOW + HOUR, outbox.layer);
          const after = yield* runAt(NOW + 2 * HOUR, outbox.layer);

          expect([failed.failed, retried.sent, after.sent]).toEqual([1, 1, 0]);
          expect(recipients(outbox.sent)).toEqual([ada]);
        })
      )
  );

  it.effect(
    "the daily send limit and an exhausted quota leave the rest for a later run",
    () =>
      withStores(
        Effect.gen(function* limited() {
          const outbox = makeOutbox();

          const members = Array.makeBy(5, (index) =>
            accountId(`user_${index}`)
          );

          yield* Effect.forEach(members, (id) => addMember(id), {
            discard: true,
          });
          yield* Effect.forEach(members, (id) => saveSearch(id), {
            discard: true,
          });
          yield* listJobs([job({ feed: "greenhouse:acme", id: "gh:1" })]);

          const capped = yield* runDigests(
            { dailySendLimit: 2, sendsPerRun: 10 },
            NOW
          ).pipe(Effect.provide(outbox.layer));

          outbox.setMode("QuotaExhausted");

          const exhausted = yield* runAt(NOW + DAY_MILLIS + HOUR, outbox.layer);

          outbox.setMode("Up");

          const drained = yield* runAt(
            NOW + DAY_MILLIS + 2 * HOUR,
            outbox.layer
          );

          expect([capped.sent, capped.skipped]).toEqual([2, 3]);
          expect([exhausted.quotaExhausted, exhausted.failed]).toEqual([
            true,
            1,
          ]);
          expect(drained.sent).toBe(3);
          expect(recipients(outbox.sent)).toEqual(members.toSorted());
        })
      )
  );

  it.effect("a member receives at most two digests in any seven days", () =>
    withStores(
      Effect.gen(function* capped() {
        yield* addMember(ada);

        const claims = yield* AlertStore.use((store) =>
          Effect.forEach([0, 1, 2], (week) =>
            store.claimDigest(
              ada,
              MONDAY + week * WEEK_MILLIS,
              MONDAY + 6 * DAY_MILLIS + week
            )
          )
        );

        expect(claims).toEqual([true, true, false]);
      })
    )
  );
});

describe("saved searches", () => {
  it.effect(
    "saving the same filters twice keeps one search, and the limit refuses the next",
    () =>
      withStores(
        Effect.gen(function* limit() {
          yield* addMember(ada);

          const first = yield* saveSearch(ada);

          const again = yield* saveSearch(ada, {
            ...everywhere,
            roles: ["Director", "EngineeringManager"],
          });

          yield* Effect.forEach(
            Array.range(1, MAX_SAVED_SEARCHES - 1),
            (index) =>
              saveSearch(ada, { ...everywhere, search: `term ${index}` }),
            { discard: true }
          );

          const over = yield* saveSearch(ada, {
            ...everywhere,
            search: "over",
          });

          const searches = yield* AlertStore.use((store) =>
            store.searchesOf(ada)
          );

          const idOf = Option.map(
            (search: { readonly id: string }) => search.id
          );

          expect(idOf(again)).toEqual(idOf(first));
          expect(searches).toHaveLength(MAX_SAVED_SEARCHES);
          expect(Option.isNone(over)).toBe(true);
        })
      )
  );

  it.effect("saving a search turns digests back on after an unsubscribe", () =>
    withStores(
      Effect.gen(function* resubscribe() {
        const outbox = makeOutbox();

        yield* addMember(ada);
        yield* AlertStore.use((store) => store.unsubscribe(ada, NOW));
        yield* saveSearch(ada);
        yield* listJobs([job({ feed: "greenhouse:acme", id: "gh:1" })]);
        yield* runAt(NOW, outbox.layer);

        expect(recipients(outbox.sent)).toEqual([ada]);
      })
    )
  );

  it.effect("one member cannot delete another member's search", () =>
    withStores(
      Effect.gen(function* foreign() {
        yield* addMember(ada);
        yield* addMember(bob);

        const saved = yield* saveSearch(ada);

        yield* AlertStore.use((store) =>
          Option.match(saved, {
            onNone: () => Effect.void,
            onSome: (search) => store.deleteSearch(bob, search.id),
          })
        );

        expect(
          yield* AlertStore.use((store) => store.searchesOf(ada))
        ).toHaveLength(1);
      })
    )
  );
});
