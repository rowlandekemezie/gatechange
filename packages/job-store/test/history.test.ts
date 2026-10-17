import { describe, expect, it } from "@effect/vitest";
import {
  DAY_MILLIS,
  FeedUnavailable,
  INGEST_LEASE_MILLIS,
  JobStore,
  PostingFeeds,
  runIngest,
} from "@rat-stack/core";
import type {
  FeedRef,
  JobQueryValue,
  ListingHistory,
  PostingValue,
} from "@rat-stack/core";
import {
  Array,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  pipe,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";

import { SqlExecutor, statement } from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const feeds = ["greenhouse:acme", "remoteok:all"] as const;

type FeedKey = (typeof feeds)[number];

type Response = readonly PostingValue[] | "down";

const catalogIn = (order: readonly FeedKey[]): readonly FeedRef[] =>
  pipe(
    order,
    Array.map((key) => ({
      company: Option.some("Acme"),
      key,
      minIntervalMinutes: 1,
      source: "Greenhouse" as const,
    }))
  );

const posting = (
  externalId: string,
  title = "Senior Engineering Manager, Payments"
): PostingValue => ({
  company: "Acme",
  externalId,
  location: "Remote - Canada",
  postedAt: null,
  salary: null,
  title,
  url: `https://jobs.example/${externalId}`,
  workplace: "Unspecified",
});

const role = posting("1");

const listAll: JobQueryValue = {
  limit: 100,
  maxAgeDays: 30,
  offset: 0,
  regions: [],
  roles: [],
  salaryFloor: null,
  search: "",
  seniorities: [],
  sort: "Newest",
};

const ingestAt = (
  day: number,
  responses: Partial<Readonly<Record<FeedKey, Response>>>,
  order: readonly FeedKey[] = feeds
) =>
  Effect.gen(function* ingestDay() {
    yield* TestClock.setTime(NOW + day * DAY_MILLIS);

    const store = yield* JobStore;

    const written = new Map<string, Deferred.Deferred<boolean>>(
      Array.zip(
        order,
        yield* Effect.all(
          pipe(
            order,
            Array.map(() => Deferred.make<boolean>())
          )
        )
      )
    );

    const markWritten = (key: string) =>
      Effect.suspend(() =>
        Option.match(Option.fromNullishOr(written.get(key)), {
          onNone: () => Effect.void,
          onSome: (done) => Deferred.succeed(done, true),
        })
      );

    const turnOf = (key: string) =>
      pipe(
        Array.findFirstIndex(order, (candidate) => candidate === key),
        Option.flatMap((index) => Array.get(order, index - 1)),
        Option.flatMap((previous) =>
          Option.fromNullishOr(written.get(previous))
        ),
        Option.match({
          onNone: () => Effect.void,
          onSome: (previous) => Deferred.await(previous),
        })
      );

    const ordered = JobStore.of({
      ...store,
      recordFeedFailure: (feedKey, attemptedAt, message) =>
        store
          .recordFeedFailure(feedKey, attemptedAt, message)
          .pipe(Effect.ensuring(markWritten(feedKey))),
      replaceFeed: (feedKey, jobs, seenAt) =>
        store
          .replaceFeed(feedKey, jobs, seenAt)
          .pipe(Effect.ensuring(markWritten(feedKey))),
    });

    const scripted = PostingFeeds.of({
      catalog: catalogIn(order),
      fetch: (feed) => {
        const response = Option.fromNullishOr(
          new Map(Object.entries(responses)).get(feed.key)
        ).pipe(Option.getOrElse((): Response => []));

        return turnOf(feed.key).pipe(
          Effect.andThen(
            response === "down"
              ? Effect.fail(
                  new FeedUnavailable({ feed: feed.key, message: "down" })
                )
              : Effect.succeed(response)
          )
        );
      },
    });

    return yield* runIngest({
      feedConcurrency: feeds.length,
      feedsPerRun: feeds.length,
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(PostingFeeds, scripted),
          Layer.succeed(JobStore, ordered)
        )
      )
    );
  });

const historyOfRole = Effect.gen(function* readHistory() {
  const store = yield* JobStore;

  return yield* store.historyOf(role);
});

const withSqlStore = <A, E>(
  body: Effect.Effect<A, E, JobStore | SqlExecutor>
) =>
  Effect.gen(function* runWithSqlStore() {
    const layer = yield* sqlJsJobStore;

    return yield* body.pipe(Effect.provide(layer));
  });

const repostsOf = (history: Option.Option<ListingHistory>) =>
  pipe(
    history,
    Option.map((found) => found.reposts)
  );

describe("listing history through runIngest on the SQL store", () => {
  it.effect(
    "a role reposted twice, listed in between, counts two reposts and keeps its first-seen date",
    () =>
      withSqlStore(
        Effect.gen(function* repostedTwice() {
          yield* ingestAt(0, { "greenhouse:acme": [role] });
          yield* ingestAt(1, { "greenhouse:acme": [role] });
          yield* ingestAt(2, { "greenhouse:acme": [] });
          yield* ingestAt(10, { "greenhouse:acme": [role] });
          yield* ingestAt(11, { "greenhouse:acme": [role] });
          yield* ingestAt(12, { "greenhouse:acme": [] });
          yield* ingestAt(20, { "greenhouse:acme": [role] });

          expect(yield* historyOfRole).toStrictEqual(
            Option.some({
              firstSeenAt: NOW,
              lastSeenAt: NOW + 20 * DAY_MILLIS,
              reposts: 2,
              sightings: 5,
            })
          );
        })
      )
  );

  it.effect(
    "an undated role the feed keeps listing past the 30-day prune is never a repost",
    () =>
      withSqlStore(
        Effect.gen(function* listedThroughPrune() {
          const pruned = yield* Effect.forEach(Array.range(0, 40), (day) =>
            ingestAt(day, { "greenhouse:acme": [role] }).pipe(
              Effect.map(({ receipt }) => receipt.jobsPruned)
            )
          );

          const store = yield* JobStore;
          const page = yield* store.list(listAll, NOW + 40 * DAY_MILLIS);

          expect(Array.reduce(pruned, 0, (total, count) => total + count)).toBe(
            1
          );
          expect(yield* historyOfRole).toStrictEqual(
            Option.some({
              firstSeenAt: NOW,
              lastSeenAt: NOW + 40 * DAY_MILLIS,
              reposts: 0,
              sightings: 41,
            })
          );
          expect(
            pipe(
              page.jobs,
              Array.map((job) => [job.daysOpen, job.reposts])
            )
          ).toStrictEqual([[40, 0]]);
        })
      )
  );

  it.effect(
    "a feed that lists nothing for one run and lists the role again within the gap counts no repost",
    () =>
      withSqlStore(
        Effect.gen(function* emptyFeedBlip() {
          yield* ingestAt(0, { "greenhouse:acme": [role] });
          yield* ingestAt(1, { "greenhouse:acme": [] });
          yield* ingestAt(7, { "greenhouse:acme": [role] });

          expect(repostsOf(yield* historyOfRole)).toStrictEqual(Option.some(0));
        })
      )
  );

  it.effect(
    "a role its feed keeps listing under a new id for more than seven days, then under the old id again, counts no repost",
    () =>
      withSqlStore(
        Effect.gen(function* idSwap() {
          const renumbered = posting("2");

          yield* ingestAt(0, { "greenhouse:acme": [role] });
          yield* ingestAt(1, { "greenhouse:acme": [renumbered] });
          yield* ingestAt(5, { "greenhouse:acme": [renumbered] });
          yield* ingestAt(9, { "greenhouse:acme": [renumbered] });
          yield* ingestAt(12, { "greenhouse:acme": [role] });

          expect(yield* historyOfRole).toStrictEqual(
            Option.some({
              firstSeenAt: NOW,
              lastSeenAt: NOW + 12 * DAY_MILLIS,
              reposts: 0,
              sightings: 5,
            })
          );
        })
      )
  );

  it.effect("a feed that goes down leaves history exactly as it was", () =>
    withSqlStore(
      Effect.gen(function* downFeed() {
        const other = posting("2", "Director of Engineering");

        yield* ingestAt(0, { "greenhouse:acme": [role, other] });

        const store = yield* JobStore;
        const before = yield* Effect.forEach([role, other], store.historyOf);

        yield* ingestAt(9, { "greenhouse:acme": "down" });

        const after = yield* Effect.forEach([role, other], store.historyOf);
        const page = yield* store.list(listAll, NOW + 9 * DAY_MILLIS);

        expect(after).toStrictEqual(before);
        expect(page.total).toBe(2);
      })
    )
  );

  it.effect(
    "a role absent for more than seven days counts one repost and keeps its first-seen date",
    () =>
      withSqlStore(
        Effect.gen(function* absentThenBack() {
          yield* ingestAt(0, { "greenhouse:acme": [role] });
          yield* ingestAt(1, { "greenhouse:acme": [] });
          yield* ingestAt(8, { "greenhouse:acme": [posting("9")] });

          const store = yield* JobStore;
          const page = yield* store.list(listAll, NOW + 8 * DAY_MILLIS);

          expect(yield* historyOfRole).toStrictEqual(
            Option.some({
              firstSeenAt: NOW,
              lastSeenAt: NOW + 8 * DAY_MILLIS,
              reposts: 1,
              sightings: 2,
            })
          );
          expect(
            pipe(
              page.jobs,
              Array.map((job) => [job.id, job.daysOpen, job.reposts])
            )
          ).toStrictEqual([["greenhouse:acme:9", 8, 1]]);
        })
      )
  );

  it.effect(
    "a feed that goes down for a week and recovers still listing the role counts no repost",
    () =>
      withSqlStore(
        Effect.gen(function* downThenRecovered() {
          yield* ingestAt(0, { "greenhouse:acme": [role] });
          yield* ingestAt(1, { "greenhouse:acme": "down" });
          yield* ingestAt(4, { "greenhouse:acme": "down" });
          yield* ingestAt(8, { "greenhouse:acme": [role] });

          expect(yield* historyOfRole).toStrictEqual(
            Option.some({
              firstSeenAt: NOW,
              lastSeenAt: NOW + 8 * DAY_MILLIS,
              reposts: 0,
              sightings: 2,
            })
          );
        })
      )
  );

  it.effect(
    "a listed role whose title is edited keeps its original first-seen date",
    () =>
      withSqlStore(
        Effect.gen(function* titleEdit() {
          const edited = posting("1", "Senior Engineering Manager, Billing");

          yield* ingestAt(0, { "greenhouse:acme": [role] });
          yield* ingestAt(3, { "greenhouse:acme": [edited] });

          const store = yield* JobStore;
          const page = yield* store.list(listAll, NOW + 3 * DAY_MILLIS);

          expect(
            pipe(
              page.jobs,
              Array.map((job) => [job.title, job.daysOpen, job.reposts])
            )
          ).toStrictEqual([[edited.title, 3, 0]]);
          expect(
            pipe(
              yield* store.historyOf(edited),
              Option.map((found) => found.firstSeenAt)
            )
          ).toStrictEqual(Option.some(NOW));
        })
      )
  );

  it.effect(
    "an older run that finishes after a newer one never moves the feed's last attempt or success back",
    () =>
      withSqlStore(
        Effect.gen(function* overlappingRuns() {
          const store = yield* JobStore;
          const key = "greenhouse:acme";

          yield* store.recordFeedFailure(key, NOW + 5 * DAY_MILLIS, "down");
          yield* store.replaceFeed(key, [], NOW + 10 * DAY_MILLIS);
          yield* store.replaceFeed(key, [], NOW + 3 * DAY_MILLIS);

          expect(yield* store.feedStates).toStrictEqual([
            {
              consecutiveFailures: 0,
              key,
              lastAttemptAt: NOW + 10 * DAY_MILLIS,
              lastError: null,
              lastSuccessAt: NOW + 10 * DAY_MILLIS,
            },
          ]);
        })
      )
  );

  it.effect(
    "an older failed attempt that lands after a newer success never moves the feed's last attempt back",
    () =>
      withSqlStore(
        Effect.gen(function* lateFailure() {
          const store = yield* JobStore;
          const key = "greenhouse:acme";

          yield* store.replaceFeed(key, [], NOW + 10 * DAY_MILLIS);
          yield* store.recordFeedFailure(key, NOW + 4 * DAY_MILLIS, "down");

          expect(yield* store.feedStates).toStrictEqual([
            {
              consecutiveFailures: 1,
              key,
              lastAttemptAt: NOW + 10 * DAY_MILLIS,
              lastError: "down",
              lastSuccessAt: NOW + 10 * DAY_MILLIS,
            },
          ]);
        })
      )
  );

  it.effect(
    "two successes landing in either order leave the same last and previous success",
    () =>
      Effect.gen(function* successOrder() {
        const key = "greenhouse:acme";
        const earlier = NOW + 8 * DAY_MILLIS;
        const later = earlier + 2;

        const successesLandingIn = (order: readonly number[]) =>
          withSqlStore(
            Effect.gen(function* landSuccesses() {
              const store = yield* JobStore;
              const sql = yield* SqlExecutor;

              yield* store.replaceFeed(key, [], NOW);
              yield* Effect.all(
                pipe(
                  order,
                  Array.map((seenAt) => store.replaceFeed(key, [], seenAt))
                )
              );

              return yield* sql.all(
                "read feed successes",
                statement(
                  "SELECT last_success_at, previous_success_at FROM feeds WHERE key = ?",
                  [key]
                ),
                Schema.Struct({
                  last_success_at: Schema.Number,
                  previous_success_at: Schema.NullOr(Schema.Number),
                })
              );
            })
          );

        const landed = [
          { last_success_at: later, previous_success_at: earlier },
        ];

        expect(yield* successesLandingIn([earlier, later])).toStrictEqual(
          landed
        );
        expect(yield* successesLandingIn([later, earlier])).toStrictEqual(
          landed
        );
      })
  );
});

const bothOrders: readonly (readonly FeedKey[])[] = [feeds, feeds.toReversed()];

const historyInBothOrders = <E>(
  script: (order: readonly FeedKey[]) => Effect.Effect<void, E, JobStore>
) =>
  Effect.all(
    pipe(
      bothOrders,
      Array.map((order) =>
        withSqlStore(script(order).pipe(Effect.andThen(historyOfRole)))
      )
    )
  );

const repostsInBothOrders = (expected: number) =>
  Array.replicate(Option.some(expected), bothOrders.length);

const daysBetween = (first: number, last: number) => Array.range(first, last);

const listedByBoth = (order: readonly FeedKey[], laterFeed: FeedKey) =>
  Effect.gen(function* script() {
    const otherFeed =
      laterFeed === "remoteok:all" ? "greenhouse:acme" : "remoteok:all";

    yield* ingestAt(
      0,
      { "greenhouse:acme": [role], "remoteok:all": [role] },
      order
    );
    yield* Effect.forEach(daysBetween(1, 9), (day) =>
      ingestAt(day, { [laterFeed]: "down", [otherFeed]: [] }, order)
    );
    yield* ingestAt(10, { [laterFeed]: [role], [otherFeed]: "down" }, order);
  });

describe("reposts do not depend on which feed's write lands first", () => {
  it.effect(
    "a board down for nine days while an aggregator succeeds without the role, then both list it, counts no repost",
    () =>
      Effect.gen(function* boardOutage() {
        const histories = yield* historyInBothOrders((order) =>
          Effect.gen(function* script() {
            yield* ingestAt(0, { "greenhouse:acme": [role] }, order);
            yield* Effect.forEach(daysBetween(1, 9), (day) =>
              ingestAt(
                day,
                { "greenhouse:acme": "down", "remoteok:all": [] },
                order
              )
            );
            yield* ingestAt(
              10,
              { "greenhouse:acme": [role], "remoteok:all": [role] },
              order
            );
          })
        );

        expect(pipe(histories, Array.map(repostsOf))).toStrictEqual(
          repostsInBothOrders(0)
        );
      })
  );

  it.effect(
    "an aggregator that picks up a role while its board is down counts no repost",
    () =>
      Effect.gen(function* aggregatorPickup() {
        const histories = yield* historyInBothOrders((order) =>
          Effect.gen(function* script() {
            yield* ingestAt(0, { "greenhouse:acme": [role] }, order);
            yield* Effect.forEach(daysBetween(1, 9), (day) =>
              ingestAt(
                day,
                { "greenhouse:acme": "down", "remoteok:all": [] },
                order
              )
            );
            yield* ingestAt(
              10,
              { "greenhouse:acme": "down", "remoteok:all": [role] },
              order
            );
          })
        );

        expect(pipe(histories, Array.map(repostsOf))).toStrictEqual(
          repostsInBothOrders(0)
        );
      })
  );

  it.effect(
    "a board that succeeds without the role, then an aggregator listing it more than seven days later, counts one repost",
    () =>
      Effect.gen(function* boardDropped() {
        const histories = yield* historyInBothOrders((order) =>
          Effect.gen(function* script() {
            yield* ingestAt(0, { "greenhouse:acme": [role] }, order);
            yield* ingestAt(1, { "greenhouse:acme": [] }, order);
            yield* ingestAt(9, { "remoteok:all": [role] }, order);
          })
        );

        expect(pipe(histories, Array.map(repostsOf))).toStrictEqual(
          repostsInBothOrders(1)
        );
      })
  );

  it.effect(
    "a role two feeds listed in the same run remembers the lower feed key as its last-seen feed",
    () =>
      Effect.gen(function* tiedLastSeen() {
        const boardSawItGone = yield* historyInBothOrders((order) =>
          listedByBoth(order, "remoteok:all")
        );

        const aggregatorSawItGone = yield* historyInBothOrders((order) =>
          listedByBoth(order, "greenhouse:acme")
        );

        expect(pipe(boardSawItGone, Array.map(repostsOf))).toStrictEqual(
          repostsInBothOrders(1)
        );
        expect(pipe(aggregatorSawItGone, Array.map(repostsOf))).toStrictEqual(
          repostsInBothOrders(0)
        );
      })
  );

  it.effect(
    "a last-seen feed that succeeds without the role in the run where another feed lists it is judged by its earlier successes",
    () =>
      Effect.gen(function* sameRunSuccess() {
        const neverSawItGone = yield* historyInBothOrders((order) =>
          Effect.gen(function* script() {
            yield* ingestAt(0, { "greenhouse:acme": [role] }, order);
            yield* ingestAt(5, { "greenhouse:acme": "down" }, order);
            yield* ingestAt(
              10,
              { "greenhouse:acme": [], "remoteok:all": [role] },
              order
            );
          })
        );

        const sawItGoneEarlier = yield* historyInBothOrders((order) =>
          Effect.gen(function* script() {
            yield* ingestAt(0, { "greenhouse:acme": [role] }, order);
            yield* ingestAt(2, { "greenhouse:acme": [] }, order);
            yield* ingestAt(
              10,
              { "greenhouse:acme": [], "remoteok:all": [role] },
              order
            );
          })
        );

        expect(pipe(neverSawItGone, Array.map(repostsOf))).toStrictEqual(
          repostsInBothOrders(0)
        );
        expect(pipe(sawItGoneEarlier, Array.map(repostsOf))).toStrictEqual(
          repostsInBothOrders(1)
        );
      })
  );

  it.effect(
    "two overlapping runs that both see the board without the role count one repost whichever board write lands first",
    () =>
      Effect.gen(function* overlappingBoardSuccesses() {
        const runA = NOW + 8 * DAY_MILLIS;
        const runB = runA + 2;

        const histories = yield* historyInBothOrders((order) =>
          Effect.gen(function* script() {
            const store = yield* JobStore;

            const boardWrites =
              order[0] === "greenhouse:acme" ? [runA, runB] : [runB, runA];

            yield* ingestAt(0, { "greenhouse:acme": [role] }, order);
            yield* Effect.all(
              pipe(
                boardWrites,
                Array.map((seenAt) =>
                  store.replaceFeed("greenhouse:acme", [], seenAt)
                )
              )
            );
            yield* ingestAt(
              (runB - NOW) / DAY_MILLIS,
              { "remoteok:all": [role] },
              ["remoteok:all"]
            );
          })
        );

        expect(pipe(histories, Array.map(repostsOf))).toStrictEqual(
          repostsInBothOrders(1)
        );
      })
  );

  it.effect(
    "a role that moves from the aggregator to the board is judged by the board once the board lists it",
    () =>
      Effect.gen(function* handoff() {
        const histories = yield* historyInBothOrders((order) =>
          Effect.gen(function* script() {
            yield* ingestAt(0, { "remoteok:all": [role] }, order);
            yield* ingestAt(
              1,
              { "greenhouse:acme": [role], "remoteok:all": "down" },
              order
            );
            yield* ingestAt(2, { "remoteok:all": "down" }, order);
            yield* ingestAt(11, { "remoteok:all": [role] }, order);
          })
        );

        expect(pipe(histories, Array.map(repostsOf))).toStrictEqual(
          repostsInBothOrders(1)
        );
      })
  );
});

interface Run {
  readonly at: number;
  readonly responses: Partial<Readonly<Record<FeedKey, Response>>>;
}

const runGated = (run: Run, gate: Effect.Effect<void>) =>
  Effect.gen(function* gatedRun() {
    yield* TestClock.setTime(run.at);

    return yield* runIngest({
      feedConcurrency: feeds.length,
      feedsPerRun: feeds.length,
    }).pipe(
      Effect.provideService(
        PostingFeeds,
        PostingFeeds.of({
          catalog: catalogIn(feeds),
          fetch: (feed) => {
            const response =
              new Map<string, Response>(Object.entries(run.responses)).get(
                feed.key
              ) ?? [];

            return gate.pipe(
              Effect.andThen(
                response === "down"
                  ? Effect.fail(
                      new FeedUnavailable({ feed: feed.key, message: "down" })
                    )
                  : Effect.succeed(response)
              )
            );
          },
        })
      )
    );
  });

const listedOnce: Run = {
  at: NOW,
  responses: { "greenhouse:acme": [role] },
};

const historyAfterOverlap = (earlier: Run, later: Run) =>
  withSqlStore(
    Effect.gen(function* overlap() {
      const fetching = yield* Deferred.make<boolean>();
      const laterLanded = yield* Deferred.make<boolean>();

      yield* runGated(listedOnce, Effect.void);

      const earlierRun = yield* runGated(
        earlier,
        Deferred.succeed(fetching, true).pipe(
          Effect.andThen(Deferred.await(laterLanded))
        )
      ).pipe(Effect.exit, Effect.forkChild);

      yield* Deferred.await(fetching);

      const laterExit = yield* runGated(later, Effect.void).pipe(
        Effect.exit,
        Effect.ensuring(Deferred.succeed(laterLanded, true))
      );

      const earlierExit = yield* Fiber.join(earlierRun);

      return {
        history: yield* historyOfRole,
        ran: pipe(
          [
            [earlier, earlierExit],
            [later, laterExit],
          ] as const,
          Array.filter(([, exit]) => Exit.isSuccess(exit)),
          Array.map(([run]) => run)
        ),
      };
    })
  );

const historyAfterSerial = (runs: readonly Run[]) =>
  withSqlStore(
    Effect.forEach([listedOnce, ...runs], (run) =>
      runGated(run, Effect.void)
    ).pipe(Effect.andThen(historyOfRole))
  );

const laterRuns: readonly Run["responses"][] = [
  { "greenhouse:acme": [role] },
  { "remoteok:all": [role] },
];

describe("overlapping ingest runs", () => {
  it.effect(
    "a run that starts while another is ingesting leaves history equal to the runs that ingested, one after another",
    () =>
      Effect.all(
        pipe(
          laterRuns,
          Array.map((responses) =>
            Effect.gen(function* overlapMatchesSerial() {
              const earlier: Run = {
                at: NOW + DAY_MILLIS,
                responses: { "greenhouse:acme": [role] },
              };

              const later: Run = {
                at: NOW + DAY_MILLIS + 2 * 60_000,
                responses,
              };

              const overlapped = yield* historyAfterOverlap(earlier, later);

              expect(overlapped.history).toStrictEqual(
                yield* historyAfterSerial(overlapped.ran)
              );
              expect(overlapped.ran).toStrictEqual([earlier]);
            })
          )
        )
      )
  );

  it.effect(
    "the ingest lease admits one run at a time, frees on release, never goes back in time, readmits the same start, and lapses after its window",
    () =>
      withSqlStore(
        Effect.gen(function* leaseRules() {
          const store = yield* JobStore;

          const claim = (startedAt: number) =>
            store.claimIngest(startedAt, startedAt + INGEST_LEASE_MILLIS);

          const crashed = NOW + 10;

          expect(
            yield* Effect.all([
              claim(NOW),
              claim(NOW + 1),
              store.releaseIngest(NOW + 1).pipe(Effect.andThen(claim(NOW + 2))),
              store.releaseIngest(NOW).pipe(Effect.andThen(claim(NOW + 3))),
              store.releaseIngest(NOW + 3).pipe(Effect.andThen(claim(NOW + 2))),
              claim(NOW + 3),
              store.releaseIngest(NOW + 3).pipe(Effect.andThen(claim(crashed))),
              claim(crashed + INGEST_LEASE_MILLIS - 1),
              claim(crashed + INGEST_LEASE_MILLIS),
            ])
          ).toStrictEqual([
            true,
            false,
            false,
            true,
            false,
            true,
            true,
            false,
            true,
          ]);
        })
      )
  );

  it.effect(
    "a run that starts minutes after the previous run finished still ingests",
    () =>
      withSqlStore(
        Effect.gen(function* backToBack() {
          yield* runGated(listedOnce, Effect.void);

          const next = yield* runGated(
            { at: NOW + 2 * 60_000, responses: { "greenhouse:acme": [role] } },
            Effect.void
          );

          expect(next.receipt.feedsAttempted).toBe(feeds.length);
          expect(yield* historyOfRole).toStrictEqual(
            Option.some({
              firstSeenAt: NOW,
              lastSeenAt: NOW + 2 * 60_000,
              reposts: 0,
              sightings: 2,
            })
          );
        })
      )
  );
});
