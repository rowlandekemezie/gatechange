// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test loads checked-in migrations into an isolated SQLite database.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import {
  DAY_MILLIS,
  JobStore,
  JobStoreUnavailable,
  PostingFeeds,
  runIngest,
} from "@rat-stack/core";
import type { FeedRef } from "@rat-stack/core";
import { greenhousePostings } from "@rat-stack/job-sources";
import {
  jobStoreLayer,
  jobStoreMigrationDirectory,
  SqlExecutor,
} from "@rat-stack/job-store";
import { Array, DateTime, Effect, Layer, Option, pipe, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

const NOW = 1_760_000_000_000;

const feed: FeedRef = {
  company: Option.some("Acme"),
  key: "greenhouse:acme",
  minIntervalMinutes: 1,
  source: "Greenhouse",
};

const iso = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time));

const migratedDatabase = () => {
  const database = new DatabaseSync(":memory:");
  const directory = jobStoreMigrationDirectory();

  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    database.exec(readFileSync(`${directory}${file}`, "utf-8"));
  }

  return database;
};

const storeOn = (database: DatabaseSync) =>
  jobStoreLayer.pipe(
    Layer.provide(
      Layer.succeed(
        SqlExecutor,
        SqlExecutor.of({
          all: (operation, sql, row) =>
            Schema.decodeEffect(Schema.Array(row))(
              database.prepare(sql.sql).all(...sql.params)
            ).pipe(
              Effect.mapError(
                (failure) =>
                  new JobStoreUnavailable({
                    message: failure.message,
                    operation,
                  })
              )
            ),
          batch: (_operation, statements) =>
            Effect.sync(() => {
              database.exec("BEGIN");

              try {
                const results = statements.map((sql) => ({
                  changes: Number(
                    database.prepare(sql.sql).run(...sql.params).changes
                  ),
                }));

                database.exec("COMMIT");

                return results;
              } catch (error) {
                database.exec("ROLLBACK");
                throw error;
              }
            }),
        })
      )
    )
  );

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
