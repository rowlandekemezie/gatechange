import { describe, expect, it } from "@effect/vitest";
import {
  Array,
  Clock,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Predicate,
  References,
  Schema,
  pipe,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import {
  DAY_MILLIS,
  DEPARTED_RETENTION_MILLIS,
  FeedUnavailable,
  fingerprintOf,
  JobStore,
  JobStoreUnavailable,
  ADMISSION_DAYS,
  arrivedLongOpen,
  PostingFeeds,
  REPOST_GAP,
  runIngest,
  selectDueFeeds,
  SourceName,
  UNSEEN_RETENTION_MILLIS,
  WINDOW_HOLD_MILLIS,
} from "../src/index.js";
import type {
  FeedRef,
  JobQueryValue,
  ListingStatusValue,
  PostingValue,
} from "../src/index.js";
import { makeMemoryJobStore } from "./memory-job-store.js";
import type { MemoryJobStore } from "./memory-job-store.js";

const windowFeed = "remoteok";

const feedKeys = ["greenhouse:acme", "lever:globex", windowFeed] as const;

const catalogIn = (keys: readonly string[]): readonly FeedRef[] =>
  pipe(
    keys,
    Array.map((key) => ({
      company: Option.some("Acme"),
      coverage: key === windowFeed ? "Window" : "Complete",
      key,
      minIntervalMinutes: 1,
      source: key === windowFeed ? "RemoteOK" : "Greenhouse",
    }))
  );

const onlyFeed: FeedRef = {
  company: Option.some("Acme"),
  coverage: "Complete",
  key: "greenhouse:acme",
  minIntervalMinutes: 1,
  source: "Greenhouse",
};

const Down = Schema.TaggedStruct("Down", {});

const Listed = Schema.TaggedStruct("Listed", {
  ids: Schema.Array(Schema.Literals(["a", "b", "c", "d", "e", "f"])),
});

const FeedResponse = Schema.Union([Down, Listed]);

const Run = Schema.Tuple([FeedResponse, FeedResponse, FeedResponse]);

const runs = Arbitrary.array(Arbitrary.schema(Run), {
  maxLength: 12,
  minLength: 1,
});

const days = (maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum: 1 }));

const spacedRuns = Arbitrary.array(
  Arbitrary.schema(Schema.Tuple([Run, days(10), Schema.Boolean])),
  { maxLength: 12, minLength: 1 }
);

const down = Down.make({});

const between = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum }));

type ScheduledRun = readonly [typeof Run.Type, number, boolean];

const outages = Arbitrary.map(
  Arbitrary.all([
    spacedRuns,
    Arbitrary.schema(
      Schema.Tuple([between(0, 2), between(0, 11), between(1, 12)])
    ),
  ]),
  ([schedule, [feed, start, length]]) =>
    pipe(
      schedule,
      Array.map(([run, gapDays, reversed], index): ScheduledRun => {
        const isDown = index >= start && index < start + length;

        return [
          [
            isDown && feed === 0 ? down : run[0],
            isDown && feed === 1 ? down : run[1],
            isDown && feed === 2 ? down : run[2],
          ],
          gapDays,
          reversed,
        ];
      })
    )
);

const weeklyListings = Arbitrary.array(
  Arbitrary.schema(Schema.Tuple([FeedResponse, days(7)])),
  { maxLength: 40, minLength: 31 }
);

const postingFor = (id: string): PostingValue => ({
  company: "Acme",
  externalId: id,
  location: "Remote - Canada",
  postedAt: null,
  salary: null,
  title: `Senior Engineering Manager, Team ${id}`,
  url: `https://jobs.example/${id}`,
  workplace: "Unspecified",
});

const ingestResponses = (
  memory: MemoryJobStore,
  responses: typeof Run.Type,
  catalog: readonly FeedRef[] = catalogIn(feedKeys),
  postingOf: (id: string) => PostingValue = postingFor
) => {
  const feeds = PostingFeeds.of({
    catalog,
    fetch: (feed) => {
      const response = pipe(
        Array.findFirstIndex(feedKeys, (key) => key === feed.key),
        Option.flatMap((index) => Array.get(responses, index))
      );

      return Option.match(response, {
        onNone: () =>
          Effect.fail(
            new FeedUnavailable({ feed: feed.key, message: "missing" })
          ),
        onSome: (found) =>
          Predicate.isTagged(found, "Listed")
            ? Effect.succeed(pipe(found.ids, Array.map(postingOf)))
            : Effect.fail(
                new FeedUnavailable({ feed: feed.key, message: "down" })
              ),
      });
    },
  });

  return runIngest({
    feedConcurrency: 2,
    feedsPerRun: feedKeys.length,
  }).pipe(
    Effect.provide(
      Layer.merge(memory.layer, Layer.succeed(PostingFeeds, feeds))
    )
  );
};

const listed = (ids: (typeof Listed.Type)["ids"]) => Listed.make({ ids });

const listAll: JobQueryValue = {
  limit: 100,
  maxAgeDays: 30,
  offset: 0,
  regions: [],
  roles: [],
  salaryFloor: null,
  salaryListed: false,
  search: "",
  seniorities: [],
  sort: "Newest",
};

const uniqueIds = (ids: readonly string[]) => [...new Set(ids)].toSorted();

const listedIds = (responses: readonly (typeof FeedResponse.Type)[]) =>
  uniqueIds(
    pipe(
      responses,
      Array.flatMap((response) =>
        Predicate.isTagged(response, "Listed") ? response.ids : []
      )
    )
  );

const replayHistory = (schedule: readonly ScheduledRun[]) =>
  Effect.gen(function* replaySchedule() {
    const memory = yield* makeMemoryJobStore;
    const lastSeen = new Map<string, { at: number; feed: string }>();
    const lastSuccess = new Map<string, number>();
    const expectedReposts = new Map<string, number>();
    let before = new Map(memory.history());

    for (const [responses, gapDays, reversed] of schedule) {
      yield* TestClock.adjust(`${gapDays} days`);
      yield* ingestResponses(
        memory,
        responses,
        catalogIn(reversed ? feedKeys.toReversed() : feedKeys)
      );

      const seenAt = yield* Clock.currentTimeMillis;

      const listing = pipe(
        Array.zip(feedKeys, responses),
        Array.flatMap(([key, response]) =>
          Predicate.isTagged(response, "Listed")
            ? [[key, listedIds([response])] as const]
            : []
        )
      );

      const listedBy = new Map<string, string>();

      for (const [key, ids] of listing) {
        for (const id of ids) {
          const fingerprint = fingerprintOf(postingFor(id));
          const other = listedBy.get(fingerprint);

          listedBy.set(
            fingerprint,
            other !== undefined && other < key ? other : key
          );
        }
      }

      for (const [fingerprint, feed] of listedBy) {
        const previous = lastSeen.get(fingerprint);

        if (
          previous !== undefined &&
          seenAt - previous.at > REPOST_GAP &&
          previous.at < (lastSuccess.get(previous.feed) ?? 0)
        ) {
          expectedReposts.set(
            fingerprint,
            (expectedReposts.get(fingerprint) ?? 0) + 1
          );
        }

        lastSeen.set(fingerprint, { at: seenAt, feed });
      }

      for (const [key] of listing) {
        lastSuccess.set(key, seenAt);
      }

      const after = new Map(memory.history());

      for (const [fingerprint, previous] of before) {
        const next = after.get(fingerprint);

        expect(next).toBeDefined();
        expect(next?.firstSeenAt).toBeLessThanOrEqual(previous.firstSeenAt);
        expect(next?.sightings).toBeGreaterThanOrEqual(previous.sightings);
      }

      for (const [fingerprint, found] of after) {
        expect(found.reposts).toBe(expectedReposts.get(fingerprint) ?? 0);
      }

      before = after;
    }
  });

const WEEKLY_LISTINGS_TIMEOUT_MILLIS = 30_000;

const hours = (maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum: 1 }));

const lifecycleRuns = Arbitrary.array(
  Arbitrary.schema(Schema.Tuple([Run, hours(24 * 12)])),
  { maxLength: 14, minLength: 1 }
);

const datedPostingFor = (id: string): PostingValue => ({
  ...postingFor(id),
  postedAt: id === "e" || id === "f" ? 0 : null,
});

interface ModelRow {
  readonly departedAt: number | null;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly postedAt: number;
}

const expectedStatus = (row: ModelRow, now: number): ListingStatusValue => {
  if (now - row.firstSeenAt < DAY_MILLIS && !arrivedLongOpen(row)) {
    return "new";
  }

  return now - row.postedAt < 7 * DAY_MILLIS ? "boarding" : "on_time";
};

const replayLifecycle = (
  schedule: readonly (readonly [typeof Run.Type, number])[]
) =>
  Effect.gen(function* replayLifecycleSchedule() {
    const memory = yield* makeMemoryJobStore;
    const model = new Map<string, ModelRow>();

    for (const [responses, gapHours] of schedule) {
      yield* TestClock.adjust(`${gapHours} hours`);

      const now = yield* Clock.currentTimeMillis;

      yield* ingestResponses(
        memory,
        responses,
        catalogIn(feedKeys),
        datedPostingFor
      );

      for (const [index, key] of feedKeys.entries()) {
        const response = responses[index];

        if (response === undefined || !Predicate.isTagged(response, "Listed")) {
          continue;
        }

        for (const external of uniqueIds(response.ids)) {
          const id = `${key}:${external}`;
          const postedAt = datedPostingFor(external).postedAt ?? now;
          const row = model.get(id);

          if (row !== undefined) {
            model.set(id, {
              ...row,
              departedAt: null,
              lastSeenAt: now,
              postedAt: Math.min(row.postedAt, postedAt),
            });
          } else if (
            key !== windowFeed ||
            postedAt >= now - ADMISSION_DAYS * DAY_MILLIS
          ) {
            model.set(id, {
              departedAt: null,
              firstSeenAt: now,
              lastSeenAt: now,
              postedAt,
            });
          }
        }

        for (const [id, row] of model) {
          if (
            id.startsWith(`${key}:`) &&
            row.lastSeenAt < now &&
            row.departedAt === null &&
            (key !== windowFeed || row.postedAt < now - WINDOW_HOLD_MILLIS)
          ) {
            model.set(id, { ...row, departedAt: now });
          }
        }
      }

      for (const [id, row] of model) {
        if (
          (row.departedAt ?? Number.POSITIVE_INFINITY) <
            now - DEPARTED_RETENTION_MILLIS ||
          row.lastSeenAt < now - UNSEEN_RETENTION_MILLIS
        ) {
          model.delete(id);
        }
      }

      const page = yield* Effect.gen(function* readBoard() {
        const store = yield* JobStore;

        return yield* store.list(listAll, now, SourceName.literals);
      }).pipe(Effect.provide(memory.layer));

      expect(
        pipe(
          memory.jobs(),
          Array.map((job) => job.id)
        ).toSorted()
      ).toStrictEqual([...model.keys()].toSorted());
      expect(
        pipe(
          page.jobs,
          Array.map((job) => [job.id, job.status] as const)
        ).toSorted(([left], [right]) => left.localeCompare(right))
      ).toStrictEqual(
        pipe(
          [...model],
          Array.filter(
            ([, row]) =>
              row.departedAt === null &&
              row.postedAt >= now - listAll.maxAgeDays * DAY_MILLIS
          ),
          Array.map(([id, row]) => [id, expectedStatus(row, now)] as const)
        ).toSorted(([left], [right]) => left.localeCompare(right))
      );
    }
  });

const FEED_STORE_STEPS = [
  "heldListings",
  "recordSightings",
  "markListed",
  "replaceFeed",
  "saveBoardFacts",
] as const;

type StoreStep =
  | (typeof FEED_STORE_STEPS)[number]
  | "prune"
  | "recordFeedFailure";

const refused = (operation: string) =>
  new JobStoreUnavailable({ message: "store refused", operation });

const feedsListing = () =>
  PostingFeeds.of({
    catalog: catalogIn(feedKeys),
    fetch: (feed) =>
      Effect.succeed([postingFor(feed.key.replaceAll(":", "-"))]),
  });

const failingOnce = (
  memory: MemoryJobStore,
  step: StoreStep,
  always: readonly StoreStep[] = []
) =>
  Layer.effect(
    JobStore,
    Effect.gen(function* failing() {
      const store = yield* JobStore;
      const spent = new Set<StoreStep>();

      const guarded = <A>(
        name: StoreStep,
        run: Effect.Effect<A, JobStoreUnavailable>
      ): Effect.Effect<A, JobStoreUnavailable> =>
        Effect.suspend(() => {
          if (always.includes(name)) {
            return Effect.fail(refused(name));
          }

          if (name === step && !spent.has(name)) {
            spent.add(name);

            return Effect.fail(refused(name));
          }

          return run;
        });

      return JobStore.of({
        ...store,
        heldListings: (...args) =>
          guarded("heldListings", store.heldListings(...args)),
        markListed: (...args) =>
          guarded("markListed", store.markListed(...args)),
        prune: (...args) => guarded("prune", store.prune(...args)),
        recordFeedFailure: (...args) =>
          guarded("recordFeedFailure", store.recordFeedFailure(...args)),
        recordSightings: (...args) =>
          guarded("recordSightings", store.recordSightings(...args)),
        replaceFeed: (...args) =>
          guarded("replaceFeed", store.replaceFeed(...args)),
        saveBoardFacts: (...args) =>
          guarded("saveBoardFacts", store.saveBoardFacts(...args)),
      });
    })
  ).pipe(Layer.provide(memory.layer));

describe("ingest", () => {
  it.effect.prop(
    "a company board's live rows are exactly its last successful listing, an aggregator's are everything it listed within the hold, and a feed that goes down keeps what it had",
    { schedule: runs },
    ({ schedule }) =>
      Effect.gen(function* replayRuns() {
        const memory = yield* makeMemoryJobStore;
        const expected = new Map<string, readonly string[]>();

        for (const responses of schedule) {
          yield* ingestResponses(memory, responses);

          for (const [index, key] of feedKeys.entries()) {
            const response = responses[index];

            if (
              response !== undefined &&
              Predicate.isTagged(response, "Listed")
            ) {
              expected.set(
                key,
                uniqueIds([
                  ...(key === windowFeed ? (expected.get(key) ?? []) : []),
                  ...response.ids,
                ])
              );
            }
          }

          for (const key of feedKeys) {
            const stored = pipe(
              memory.jobs(),
              Array.filter(
                (job) => job.feed === key && !memory.departed().has(job.id)
              )
            );

            expect(
              uniqueIds(
                pipe(
                  stored,
                  Array.map((job) => job.id.slice(key.length + 1))
                )
              )
            ).toStrictEqual(expected.get(key) ?? []);
          }

          yield* TestClock.adjust("2 hours");
        }

        expect(memory.runs().length).toBe(schedule.length);
      })
  );

  it.effect.prop(
    "a role a company board stops listing departs at once, a role an aggregator stops listing departs once the hold after its posting has passed, each stays one day, then goes; a failed fetch changes nothing; a company board admits a role however old its posting while an aggregator keeps the 30-day cutoff; a listed role outlives the 30-day posting window; and the board shows only live roles, each with its status",
    { schedule: lifecycleRuns },
    ({ schedule }) => replayLifecycle(schedule)
  );

  it.effect.prop(
    "history first-seen never moves later, and a role counts a repost exactly when it was absent longer than the repost gap and the feed that last listed it succeeded since, whatever order the feeds land in",
    { schedule: spacedRuns },
    ({ schedule }) => replayHistory(schedule)
  );

  it.effect.prop(
    "the repost rule holds when one feed stays down for many runs and recovers still listing its roles",
    { schedule: outages },
    ({ schedule }) => replayHistory(schedule)
  );

  it.effect.prop(
    "a role listed at least once a week past the retention window keeps its first-seen date and never counts a repost",
    { schedule: weeklyListings },
    ({ schedule }) =>
      Effect.gen(function* listedPastRetention() {
        const memory = yield* makeMemoryJobStore;
        const firstSeenAt = yield* Clock.currentTimeMillis;

        for (const [others, gapDays] of schedule) {
          yield* ingestResponses(memory, [listed(["a"]), others, others]);
          yield* TestClock.adjust(`${gapDays} days`);
        }

        const now = yield* Clock.currentTimeMillis;
        const history = memory.history().get(fingerprintOf(postingFor("a")));

        expect(now - firstSeenAt).toBeGreaterThan(ADMISSION_DAYS * DAY_MILLIS);
        expect(history?.firstSeenAt).toBe(firstSeenAt);
        expect(history?.reposts).toBe(0);
      }),
    WEEKLY_LISTINGS_TIMEOUT_MILLIS
  );

  it.effect(
    "a company board admits a long-open role and an aggregator refuses it",
    () =>
      Effect.gen(function* longOpen() {
        const memory = yield* makeMemoryJobStore;

        yield* TestClock.adjust(`${ADMISSION_DAYS + 1} days`);
        yield* ingestResponses(
          memory,
          [listed(["e", "a"]), down, listed(["e", "a"])],
          catalogIn(feedKeys),
          datedPostingFor
        );

        expect(
          pipe(
            memory.jobs(),
            Array.map((job) => job.id)
          ).toSorted()
        ).toStrictEqual([
          "greenhouse:acme:a",
          "greenhouse:acme:e",
          "remoteok:a",
        ]);
      })
  );

  it.effect(
    "an aggregator's absence keeps a role through the hold after its posting, while the same absence from a company board departs it",
    () =>
      Effect.gen(function* absence() {
        const memory = yield* makeMemoryJobStore;

        const liveIds = () =>
          pipe(
            memory.jobs(),
            Array.filter((job) => !memory.departed().has(job.id)),
            Array.map((job) => job.id)
          );

        yield* ingestResponses(memory, [listed(["a"]), down, listed(["a"])]);
        yield* TestClock.adjust("5 days");
        yield* ingestResponses(memory, [listed(["a"]), down, listed(["a"])]);
        yield* TestClock.adjust(`${WINDOW_HOLD_MILLIS / DAY_MILLIS - 6} days`);
        yield* ingestResponses(memory, [listed([]), down, listed([])]);

        expect(liveIds()).toStrictEqual(["remoteok:a"]);

        yield* TestClock.adjust("2 days");
        yield* ingestResponses(memory, [down, down, listed([])]);

        expect(liveIds()).toStrictEqual([]);
        expect(
          pipe(
            memory.jobs(),
            Array.map((job) => job.id)
          )
        ).toStrictEqual(["remoteok:a"]);

        yield* TestClock.adjust("2 days");
        yield* ingestResponses(memory, [down, down, listed([])]);

        expect(memory.jobs()).toStrictEqual([]);
      })
  );

  it.effect(
    "a role that disappears for longer than the repost gap and comes back keeps its first-seen date and counts one repost",
    () =>
      Effect.gen(function* repost() {
        const memory = yield* makeMemoryJobStore;
        const firstSeenAt = yield* Clock.currentTimeMillis;

        yield* ingestResponses(memory, [listed(["a"]), down, down]);
        yield* TestClock.adjust("2 days");
        yield* ingestResponses(memory, [listed([]), listed([]), listed([])]);
        yield* TestClock.adjust("6 days");
        yield* ingestResponses(memory, [listed(["a"]), down, down]);
        yield* TestClock.adjust("1 day");

        const now = yield* Clock.currentTimeMillis;

        const { history, page } = yield* Effect.gen(function* readHistory() {
          const store = yield* JobStore;

          return {
            history: yield* store.historyOf(postingFor("a")),
            page: yield* store.list(listAll, now, SourceName.literals),
          };
        }).pipe(Effect.provide(memory.layer));

        expect(history).toStrictEqual(
          Option.some({
            firstSeenAt,
            lastSeenAt: firstSeenAt + 8 * DAY_MILLIS,
            reposts: 1,
            sightings: 2,
          })
        );
        expect(
          pipe(
            page.jobs,
            Array.map((job) => [job.daysOpen, job.reposts])
          )
        ).toStrictEqual([[9, 1]]);
      })
  );

  it.effect(
    "a role back exactly the repost gap after it was last seen counts no repost",
    () =>
      Effect.gen(function* backAtTheGap() {
        const memory = yield* makeMemoryJobStore;

        yield* ingestResponses(memory, [listed(["a"]), down, down]);
        yield* TestClock.adjust("1 day");
        yield* ingestResponses(memory, [listed([]), down, down]);
        yield* TestClock.adjust("6 days");
        yield* ingestResponses(memory, [listed(["a"]), down, down]);

        const history = yield* Effect.gen(function* readHistory() {
          const store = yield* JobStore;

          return yield* store.historyOf(postingFor("a"));
        }).pipe(Effect.provide(memory.layer));

        expect(
          pipe(
            history,
            Option.map((found) => found.reposts)
          )
        ).toStrictEqual(Option.some(0));
      })
  );

  it.effect(
    "keeps a role whose link points back at this site off the board and logs how many roles it kept off",
    () =>
      Effect.gen(function* skipOwnLinks() {
        const memory = yield* makeMemoryJobStore;
        const warnings: unknown[] = [];

        const feeds = PostingFeeds.of({
          catalog: [onlyFeed],
          fetch: () =>
            Effect.succeed([
              postingFor("a"),
              {
                ...postingFor("b"),
                url: "https://jobs.rowlandekemezie.com/api/auth/magic-link/verify?token=x",
              },
              {
                ...postingFor("c"),
                title: "Product Manager",
                url: "/careers/c",
              },
            ]),
        });

        yield* runIngest({ feedConcurrency: 1, feedsPerRun: 1 }).pipe(
          Effect.provide(
            Layer.mergeAll(
              memory.layer,
              Layer.succeed(PostingFeeds, feeds),
              Logger.layer([
                Logger.make(({ fiber, logLevel, message }) =>
                  logLevel === "Warn"
                    ? warnings.push({
                        fields: fiber.getRef(References.CurrentLogAnnotations),
                        message,
                      })
                    : 0
                ),
              ])
            )
          )
        );

        expect(
          pipe(
            memory.jobs(),
            Array.map((job) => job.url)
          )
        ).toStrictEqual(["https://jobs.example/a"]);
        expect(warnings).toStrictEqual([
          {
            fields: { feed: onlyFeed.key, unlinked: 1 },
            message: ["kept roles without an off-site web link off the board"],
          },
        ]);
      })
  );

  it.effect.each(FEED_STORE_STEPS)(
    "a store failure in %s stays on its feed and the run still finishes",
    (step) =>
      Effect.gen(function* isolated() {
        const memory = yield* makeMemoryJobStore;

        const { outcomes, receipt } = yield* runIngest({
          feedConcurrency: 1,
          feedsPerRun: feedKeys.length,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              failingOnce(memory, step),
              Layer.succeed(PostingFeeds, feedsListing())
            )
          )
        );

        const failed = outcomes.filter(({ error }) => error !== null);

        const state = memory
          .feedStates()
          .find(({ consecutiveFailures }) => consecutiveFailures > 0);

        expect(failed).toHaveLength(1);
        expect(failed[0]?.error).toBe("store refused");
        expect(state?.key).toBe(failed[0]?.key);
        expect(state?.lastError).toBe("store refused");
        expect(receipt.outcome).toBe("Partial");
        expect(receipt.feedsFailed).toBe(1);
        expect(memory.runs()).toHaveLength(1);
      })
  );

  it.effect(
    "a feed that failed in the store backs off, and the next successful run clears it",
    () =>
      Effect.gen(function* backsOff() {
        const memory = yield* makeMemoryJobStore;

        yield* runIngest({
          feedConcurrency: 1,
          feedsPerRun: 1,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              failingOnce(memory, "replaceFeed"),
              Layer.succeed(
                PostingFeeds,
                PostingFeeds.of({ ...feedsListing(), catalog: [onlyFeed] })
              )
            )
          )
        );

        const [backedOff] = memory.feedStates();

        expect(backedOff?.consecutiveFailures).toBe(1);
        expect(
          selectDueFeeds(
            [onlyFeed],
            memory.feedStates(),
            yield* Clock.currentTimeMillis,
            1
          )
        ).toStrictEqual([]);

        yield* TestClock.adjust("2 days");

        yield* runIngest({ feedConcurrency: 1, feedsPerRun: 1 }).pipe(
          Effect.provide(
            Layer.mergeAll(
              memory.layer,
              Layer.succeed(
                PostingFeeds,
                PostingFeeds.of({ ...feedsListing(), catalog: [onlyFeed] })
              )
            )
          )
        );

        expect(memory.feedStates()[0]?.consecutiveFailures).toBe(0);
        expect(memory.jobs().map(({ feed }) => feed)).toContain(onlyFeed.key);
      })
  );

  it.effect(
    "keeps going when the failure cannot be recorded either, and leaves the receipt to say so",
    () =>
      Effect.gen(function* unrecorded() {
        const memory = yield* makeMemoryJobStore;

        const { receipt } = yield* runIngest({
          feedConcurrency: 1,
          feedsPerRun: feedKeys.length,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              failingOnce(memory, "replaceFeed", ["recordFeedFailure"]),
              Layer.succeed(PostingFeeds, feedsListing())
            )
          )
        );

        expect(receipt.feedsFailed).toBe(1);
        expect(memory.runs()).toHaveLength(1);
      })
  );

  it.effect("a store that cannot prune still fails the run", () =>
    Effect.gen(function* storeDown() {
      const memory = yield* makeMemoryJobStore;

      const exit = yield* runIngest({
        feedConcurrency: 1,
        feedsPerRun: feedKeys.length,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            failingOnce(memory, "prune"),
            Layer.succeed(PostingFeeds, feedsListing())
          )
        ),
        Effect.exit
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(memory.runs()).toHaveLength(0);
    })
  );

  it.effect("titles outside engineering leadership never reach the store", () =>
    Effect.gen(function* filterTitles() {
      const memory = yield* makeMemoryJobStore;

      const titles = [
        "Product Manager",
        "Staff Software Engineer",
        "VP of Engineering",
      ];

      const feeds = PostingFeeds.of({
        catalog: [onlyFeed],
        fetch: () =>
          Effect.succeed(
            pipe(
              titles,
              Array.map((title, index) => ({
                ...postingFor(`t${index}`),
                title,
              }))
            )
          ),
      });

      yield* runIngest({ feedConcurrency: 1, feedsPerRun: 1 }).pipe(
        Effect.provide(
          Layer.merge(memory.layer, Layer.succeed(PostingFeeds, feeds))
        )
      );

      expect(
        pipe(
          memory.jobs(),
          Array.map((job) => job.title)
        )
      ).toStrictEqual(["VP of Engineering"]);
    })
  );
});
