import { describe, expect, it } from "@effect/vitest";
import {
  AccountId,
  AlertStore,
  BillingStore,
  DAY_MILLIS,
  DigestMailer,
  DigestMailerUnavailable,
  INSTANT_SENDS_PER_MEMBER_PER_DAY,
  INSTANT_WINDOW_MILLIS,
  JobStore,
  MAX_SAVED_SEARCHES,
  runInstantAlerts,
  windowStartOf,
} from "@rat-stack/core";
import type {
  AccountIdValue,
  Digest,
  DigestPlan,
  DigestReceipt,
  JobValue,
  SubscriptionStatusValue,
} from "@rat-stack/core";
import { Array, Effect, Layer } from "effect";

import {
  alertStoreLayer,
  billingStoreLayer,
  SqlExecutor,
  statement,
} from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const NOW = windowStartOf(1_761_000_000_000) + 10 * 60_000;

const PLAN: DigestPlan = { dailySendLimit: 1000, sendsPerRun: 1000 };

const pro = AccountId.make("user_pro");

const free = AccountId.make("user_free");

const lapsed = AccountId.make("user_lapsed");

const withStores = <A, E>(
  body: Effect.Effect<
    A,
    E,
    AlertStore | BillingStore | JobStore | SqlExecutor | DigestMailer
  >,
  sent: Digest[]
) =>
  Effect.gen(function* provideStores() {
    const base = yield* sqlJsJobStore;

    return yield* body.pipe(
      Effect.provide(
        Layer.mergeAll(alertStoreLayer, billingStoreLayer).pipe(
          Layer.provideMerge(base)
        )
      ),
      Effect.provideService(
        DigestMailer,
        DigestMailer.of({
          send: (digest) =>
            Effect.sync(() => {
              sent.push(digest);
            }),
        })
      )
    );
  });

const addMember = (id: AccountIdValue) =>
  SqlExecutor.use((sql) =>
    sql.batch("addMember", [
      statement(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)`,
        [id, id, `${id}@example.com`]
      ),
    ])
  );

const subscribe = (
  account: AccountIdValue,
  status: SubscriptionStatusValue,
  periodEnd: number
) =>
  BillingStore.use((store) =>
    store.applySubscription({
      account,
      cancelAtPeriodEnd: false,
      periodEnd,
      plan: "Monthly",
      status,
      subscriptionId: `sub_${account}`,
      version: { created: 1, eventId: `evt_${account}`, rank: 0 },
    })
  );

const job = (id: string, firstSeenAt: number): JobValue => ({
  arrangement: "Remote",
  company: "Acme",
  feed: "jobicy:all",
  firstSeenAt,
  id,
  lastSeenAt: firstSeenAt,
  location: "Remote - Canada",
  postedAt: firstSeenAt,
  region: "RemoteCanada",
  relevance: 50,
  role: "Director",
  salary: null,
  source: "Jobicy",
  title: `Director of Engineering ${id}`,
  url: `https://jobicy.example/${id}`,
});

const setUp = Effect.gen(function* setUp() {
  yield* Effect.forEach([pro, free, lapsed], addMember, { discard: true });
  yield* subscribe(pro, "active", NOW + 30 * DAY_MILLIS);
  yield* subscribe(lapsed, "active", NOW - DAY_MILLIS);

  yield* AlertStore.use((store) =>
    Effect.forEach(
      [pro, free, lapsed],
      (account) =>
        Effect.andThen(
          store.saveSearch(
            account,
            { regions: ["RemoteCanada"], roles: ["Director"], search: "" },
            NOW - 2 * DAY_MILLIS,
            MAX_SAVED_SEARCHES
          ),
          store.setInstantAlerts(account, true, NOW - DAY_MILLIS)
        ),
      { discard: true }
    )
  );

  yield* JobStore.use((store) =>
    store.replaceFeed(
      "jobicy:all",
      [job("old", NOW - 2 * DAY_MILLIS), job("new", NOW - 5 * 60_000)],
      NOW - 5 * 60_000
    )
  );
});

describe("instant alerts", () => {
  it.effect(
    "emails a Pro member the matches seen since they switched alerts on, once per 20-minute window",
    () => {
      const sent: Digest[] = [];

      return withStores(
        Effect.gen(function* oncePerWindow() {
          yield* setUp;

          const first = yield* runInstantAlerts(PLAN, NOW);
          const again = yield* runInstantAlerts(PLAN, NOW + 60_000);

          const next = yield* runInstantAlerts(
            PLAN,
            NOW + INSTANT_WINDOW_MILLIS
          );

          expect(
            sent.map((digest) => [
              digest.cadence,
              digest.account,
              digest.jobs.map((listed) => listed.id),
            ])
          ).toEqual([["Instant", pro, ["new"]]]);
          expect([first.sent, again.sent, next.sent]).toEqual([1, 0, 0]);
        }),
        sent
      );
    }
  );

  it.effect(
    "never emails a Free or lapsed member, even with alerts left on",
    () => {
      const sent: Digest[] = [];

      return withStores(
        Effect.gen(function* freeMembers() {
          yield* setUp;
          yield* runInstantAlerts(PLAN, NOW);

          expect(Array.dedupe(sent.map((digest) => digest.account))).toEqual([
            pro,
          ]);
        }),
        sent
      );
    }
  );

  it.effect(
    "counts instant sends in the instant budget and leaves the weekly budget untouched",
    () => {
      const sent: Digest[] = [];

      return withStores(
        Effect.gen(function* budget() {
          yield* setUp;
          yield* runInstantAlerts(PLAN, NOW);

          const counted = yield* AlertStore.use((store) =>
            Effect.all([
              store.sendsSince("Instant", NOW - DAY_MILLIS),
              store.sendsSince("Weekly", NOW - DAY_MILLIS),
            ])
          );

          expect(counted).toEqual([1, 0]);
        }),
        sent
      );
    }
  );

  it.effect.each([false, true])(
    "a next cron window preserves unknown delivery and retries only a proven quota refusal (%s)",
    (quotaExhausted) => {
      const sent: Digest[] = [];

      return withStores(
        Effect.gen(function* nextWindow() {
          yield* setUp;

          const mailer = DigestMailer.of({
            send: (digest) =>
              Effect.gen(function* uncertainAcceptance() {
                if (!quotaExhausted) {
                  sent.push(digest);
                }

                return yield* new DigestMailerUnavailable({
                  message: "send failed",
                  quotaExhausted,
                });
              }),
          });

          const first = yield* runInstantAlerts(PLAN, NOW).pipe(
            Effect.provideService(DigestMailer, mailer)
          );

          const next = yield* runInstantAlerts(
            PLAN,
            NOW + INSTANT_WINDOW_MILLIS
          );

          expect([first.failed, next.sent]).toEqual([
            1,
            quotaExhausted ? 1 : 0,
          ]);
          expect(
            sent.map((digest) => digest.jobs.map((listed) => listed.id))
          ).toEqual([["new"]]);

          yield* JobStore.use((store) =>
            store.replaceFeed(
              "jobicy:all",
              [
                job("new", NOW - 5 * 60_000),
                job("fresh", NOW + INSTANT_WINDOW_MILLIS + 60_000),
              ],
              NOW + INSTANT_WINDOW_MILLIS + 60_000
            )
          );
          yield* runInstantAlerts(PLAN, NOW + 2 * INSTANT_WINDOW_MILLIS);
          expect(
            sent.map((digest) => digest.jobs.map((listed) => listed.id))
          ).toEqual([["new"], ["fresh"]]);
        }),
        sent
      );
    }
  );

  it.effect(
    "sends instant alerts to no more members a day than the instant share of the daily limit",
    () => {
      const sent: Digest[] = [];

      return withStores(
        Effect.gen(function* share() {
          yield* setUp;

          const others = Array.makeBy(4, (index) =>
            AccountId.make(`user_pro${index}`)
          );

          for (const account of others) {
            yield* addMember(account);
            yield* subscribe(account, "active", NOW + 30 * DAY_MILLIS);
            yield* AlertStore.use((store) =>
              Effect.andThen(
                store.saveSearch(
                  account,
                  {
                    regions: ["RemoteCanada"],
                    roles: ["Director"],
                    search: "",
                  },
                  NOW - 2 * DAY_MILLIS,
                  MAX_SAVED_SEARCHES
                ),
                store.setInstantAlerts(account, true, NOW - DAY_MILLIS)
              )
            );
          }

          const receipt = yield* runInstantAlerts(
            { dailySendLimit: 10, sendsPerRun: 100 },
            NOW
          );

          expect([receipt.due, receipt.sent]).toEqual([5, 2]);
        }),
        sent
      );
    }
  );

  it.effect(
    "refuses a seventh instant claim for one member inside 24 hours, even from a run that saw them as due",
    () =>
      withStores(
        Effect.gen(function* claimCap() {
          yield* addMember(pro);

          const claims = yield* AlertStore.use((store) =>
            Effect.forEach(Array.range(0, 7), (index) =>
              store.claimDigest(
                "Instant",
                pro,
                windowStartOf(NOW) + index * INSTANT_WINDOW_MILLIS,
                NOW + index * INSTANT_WINDOW_MILLIS,
                1000
              )
            )
          );

          const nextDay = yield* AlertStore.use((store) =>
            store.claimDigest(
              "Instant",
              pro,
              windowStartOf(NOW + DAY_MILLIS + INSTANT_WINDOW_MILLIS),
              NOW + DAY_MILLIS + INSTANT_WINDOW_MILLIS,
              1000
            )
          );

          expect([...claims, nextDay]).toEqual([
            true,
            true,
            true,
            true,
            true,
            true,
            false,
            false,
            true,
          ]);
        }),
        []
      )
  );

  it.effect(
    "emails a Pro member at most six times in any 24 hours, then sends what waited",
    () => {
      const sent: Digest[] = [];

      return withStores(
        Effect.gen(function* perMember() {
          yield* setUp;

          const receipts: DigestReceipt[] = [];

          const windows = Array.makeBy(
            INSTANT_SENDS_PER_MEMBER_PER_DAY + 2,
            (index) => NOW + index * INSTANT_WINDOW_MILLIS
          );

          for (const [index, at] of windows.entries()) {
            const live = windows.slice(0, index + 1).map((first) => ({
              ...job(`at${first}`, first - 60_000),
              lastSeenAt: at,
            }));

            yield* JobStore.use((store) =>
              store.replaceFeed("jobicy:all", live, at)
            );
            receipts.push(yield* runInstantAlerts(PLAN, at));
          }

          const capped = sent.length;

          yield* runInstantAlerts(
            PLAN,
            NOW + DAY_MILLIS + INSTANT_WINDOW_MILLIS
          );

          expect(capped).toBe(6);
          expect(receipts.map((receipt) => receipt.due)).toEqual([
            1, 1, 1, 1, 1, 1, 0, 0,
          ]);
          expect(sent.at(-1)?.jobs.map((listed) => listed.id)).toEqual(
            windows
              .slice(INSTANT_SENDS_PER_MEMBER_PER_DAY)
              .map((at) => `at${at}`)
              .toReversed()
          );
        }),
        sent
      );
    }
  );
});
