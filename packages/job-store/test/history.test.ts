import { describe, expect, it } from "@effect/vitest";
import {
  DAY_MILLIS,
  FeedUnavailable,
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
import { Array, Effect, Layer, Option, pipe } from "effect";
import { TestClock } from "effect/testing";

import { sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const feeds = ["greenhouse:acme", "remoteok:all"] as const;

type FeedKey = (typeof feeds)[number];

type Response = readonly PostingValue[] | "down";

const catalog: readonly FeedRef[] = pipe(
  feeds,
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
  search: "",
  sort: "Newest",
};

const ingestAt = (
  day: number,
  responses: Partial<Readonly<Record<FeedKey, Response>>>
) =>
  Effect.gen(function* ingestDay() {
    yield* TestClock.setTime(NOW + day * DAY_MILLIS);

    const scripted = PostingFeeds.of({
      catalog,
      fetch: (feed) => {
        const response = Option.fromNullishOr(
          new Map(Object.entries(responses)).get(feed.key)
        ).pipe(Option.getOrElse((): Response => []));

        return response === "down"
          ? Effect.fail(
              new FeedUnavailable({ feed: feed.key, message: "down" })
            )
          : Effect.succeed(response);
      },
    });

    return yield* runIngest({
      feedConcurrency: 1,
      feedsPerRun: feeds.length,
    }).pipe(Effect.provide(Layer.succeed(PostingFeeds, scripted)));
  });

const historyOfRole = Effect.gen(function* readHistory() {
  const store = yield* JobStore;

  return yield* store.historyOf(role);
});

const withSqlStore = <A, E>(body: Effect.Effect<A, E, JobStore>) =>
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
    "a role that stays listed while its id changes counts no repost",
    () =>
      withSqlStore(
        Effect.gen(function* idSwap() {
          yield* ingestAt(0, { "greenhouse:acme": [role] });
          yield* ingestAt(1, { "greenhouse:acme": [posting("2")] });
          yield* ingestAt(2, {
            "greenhouse:acme": [],
            "remoteok:all": [posting("3")],
          });

          expect(repostsOf(yield* historyOfRole)).toStrictEqual(Option.some(0));
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
});
