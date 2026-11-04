import { describe, expect, it } from "@effect/vitest";
import { DAY_MILLIS, JobStore, PostingFeeds, runIngest } from "@rat-stack/core";
import type { FeedRef } from "@rat-stack/core";
import { greenhousePostings } from "@rat-stack/job-sources";
import { Array, DateTime, Effect, Option, pipe } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { migratedDatabase, storeOn } from "./sqlite-job-store.js";

const NOW = 1_760_000_000_000;

const feed: FeedRef = {
  company: Option.some("Acme"),
  coverage: "Complete",
  key: "greenhouse:acme",
  minIntervalMinutes: 1,
  source: "Greenhouse",
};

const iso = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time));

const ingestAt = Effect.fnUntraced(function* ingestAt(
  day: number,
  firstPublished: string | null,
  updatedAt: number
) {
  const now = NOW + day * DAY_MILLIS;
  yield* TestClock.setTime(now);

  const http = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          jobs: [
            {
              absolute_url: "https://boards.greenhouse.io/acme/jobs/42",
              first_published: firstPublished,
              id: 42,
              location: { name: "Remote - Canada" },
              title: "Engineering Manager",
              updated_at: iso(updatedAt),
            },
          ],
        })
      )
    )
  );

  return yield* runIngest({ feedConcurrency: 1, feedsPerRun: 1 }).pipe(
    Effect.provideService(
      PostingFeeds,
      PostingFeeds.of({
        catalog: [feed],
        fetch: () =>
          greenhousePostings(feed.key, "acme").pipe(
            Effect.provideService(HttpClient.HttpClient, http)
          ),
      })
    )
  );
});

const identity = { company: "Acme", title: "Engineering Manager" };

const withStore = <A, E>(body: Effect.Effect<A, E, JobStore>) =>
  Effect.acquireUseRelease(
    Effect.sync(migratedDatabase),
    (database) => body.pipe(Effect.provide(storeOn(database))),
    (database) =>
      Effect.sync(() => {
        database.close();
      })
  );

describe("Greenhouse dates through adapter, ingest and SQL history", () => {
  it.effect(
    "an always-listed undated role keeps every sighting and gains no repost when an old edit date is refreshed",
    () =>
      withStore(
        Effect.gen(function* continuousUndatedRole() {
          const oldEdit = NOW - 31 * DAY_MILLIS;
          yield* ingestAt(-8, null, oldEdit);

          const dailyRuns = yield* Effect.forEach(Array.range(0, 7), (day) =>
            ingestAt(day, null, oldEdit)
          );

          const edited = yield* ingestAt(8, null, NOW + 8 * DAY_MILLIS);
          const store = yield* JobStore;

          expect(yield* store.historyOf(identity)).toStrictEqual(
            Option.some({
              firstSeenAt: NOW - 8 * DAY_MILLIS,
              lastSeenAt: NOW + 8 * DAY_MILLIS,
              reposts: 0,
              sightings: 10,
            })
          );
          expect(
            dailyRuns.map(({ receipt }) => receipt.jobsUpserted)
          ).toStrictEqual(Array.replicate(1, 8));
          expect(edited.receipt.jobsUpserted).toBe(1);

          const company = yield* store.companyRecords(
            "acme",
            NOW + 8 * DAY_MILLIS
          );

          expect(
            company.open.map(({ openedAt, reposts }) => ({ openedAt, reposts }))
          ).toStrictEqual([{ openedAt: NOW - 8 * DAY_MILLIS, reposts: 0 }]);

          const listing = yield* store.find("greenhouse:acme:42");
          expect(listing.pipe(Option.map((job) => job.postedAt))).toStrictEqual(
            Option.some(NOW - 8 * DAY_MILLIS)
          );
        })
      )
  );

  it.effect(
    "a long-open role on a new board is admitted once with its first sighting, then only refreshed",
    () =>
      withStore(
        Effect.gen(function* longOpen() {
          const published = iso(NOW - 106 * DAY_MILLIS);
          const first = yield* ingestAt(0, published, NOW);
          const second = yield* ingestAt(1, published, NOW);
          const store = yield* JobStore;
          const kept = yield* store.find("greenhouse:acme:42");

          expect(first.receipt.jobsUpserted).toBe(1);
          expect(second.receipt.jobsUpserted).toBe(0);
          expect(
            pipe(
              kept,
              Option.map(({ firstSeenAt, lastSeenAt, postedAt }) => ({
                firstSeenAt,
                lastSeenAt,
                postedAt,
              }))
            )
          ).toStrictEqual(
            Option.some({
              firstSeenAt: NOW,
              lastSeenAt: NOW + DAY_MILLIS,
              postedAt: NOW - 106 * DAY_MILLIS,
            })
          );
          expect(yield* store.historyOf(identity)).toStrictEqual(
            Option.some({
              firstSeenAt: NOW,
              lastSeenAt: NOW,
              reposts: 0,
              sightings: 1,
            })
          );
        })
      )
  );

  it.effect(
    "a role published over 30 days ago stays while its board lists it, without fresh upserts or sightings",
    () =>
      withStore(
        Effect.gen(function* truePublication() {
          const published = iso(NOW - 31 * DAY_MILLIS);
          yield* ingestAt(-8, published, NOW - 31 * DAY_MILLIS);
          const aged = yield* ingestAt(0, published, NOW);
          const edited = yield* ingestAt(8, published, NOW + 8 * DAY_MILLIS);
          const store = yield* JobStore;

          expect(aged.receipt.jobsUpserted).toBe(0);
          expect(edited.receipt.jobsUpserted).toBe(0);
          const kept = yield* store.find("greenhouse:acme:42");

          expect(
            pipe(
              kept,
              Option.map((job) => job.lastSeenAt)
            )
          ).toStrictEqual(Option.some(NOW + 8 * DAY_MILLIS));
          expect(yield* store.historyOf(identity)).toStrictEqual(
            Option.some({
              firstSeenAt: NOW - 8 * DAY_MILLIS,
              lastSeenAt: NOW - 8 * DAY_MILLIS,
              reposts: 0,
              sightings: 1,
            })
          );
        })
      )
  );
});
