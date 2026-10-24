import { describe, expect, it } from "@effect/vitest";
import {
  DAY_MILLIS,
  FeedUnavailable,
  JobStore,
  PostingFeeds,
  runIngest,
  SourceName,
} from "@rat-stack/core";
import type { FeedRef, JobValue } from "@rat-stack/core";
import { Array, Effect, Option, Schema } from "effect";
import { TestClock } from "effect/testing";

import {
  makeJobStore,
  SqlExecutor,
  statement,
  UPSERT_CHUNK,
} from "../src/index.js";
import type { SqlStatement } from "../src/index.js";
import { seededSqlJsJobStore, sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const FEED = "greenhouse:acme";

const job = (id: string, overrides: Partial<JobValue> = {}): JobValue => ({
  arrangement: "Remote",
  company: "Acme",
  feed: FEED,
  firstSeenAt: NOW,
  id,
  lastSeenAt: NOW,
  location: "Remote - Canada",
  postedAt: NOW,
  region: "RemoteCanada",
  relevance: 50,
  role: "EngineeringManager",
  salary: null,
  source: "Greenhouse",
  title: `Engineering Manager ${id}`,
  url: `https://jobs.example/${id}`,
  ...overrides,
});

const JobRow = Schema.Struct({
  departed_at: Schema.NullOr(Schema.Number),
  first_seen_at: Schema.Number,
  id: Schema.String,
  last_seen_at: Schema.Number,
});

const jobRows = Effect.gen(function* readJobRows() {
  const sql = yield* SqlExecutor;

  return yield* sql.all(
    "jobRows",
    statement(
      "SELECT id, first_seen_at, last_seen_at, departed_at FROM jobs ORDER BY id"
    ),
    JobRow
  );
});

const listedIds = (now: number) =>
  Effect.gen(function* readListed() {
    const store = yield* JobStore;

    const listing = yield* store.list(
      {
        limit: 500,
        maxAgeDays: 30,
        offset: 0,
        regions: [],
        roles: [],
        salaryFloor: null,
        salaryListed: false,
        search: "",
        seniorities: [],
        sort: "Newest",
      },
      now,
      SourceName.literals
    );

    return listing.jobs.map(({ id }) => id).toSorted();
  });

const relistings = {
  "admitted again": (role: JobValue, at: number) =>
    Effect.gen(function* admitted() {
      const store = yield* JobStore;

      yield* store.replaceFeed(
        FEED,
        [{ ...role, firstSeenAt: at, lastSeenAt: at }],
        at
      );
    }),
  "listed past the admission window": (role: JobValue, at: number) =>
    Effect.gen(function* stillListed() {
      const store = yield* JobStore;

      yield* store.markListed(FEED, [role.id], at);
      yield* store.replaceFeed(FEED, [], at);
    }),
};

describe("job departures over SQL", () => {
  it.effect.each(Object.entries(relistings))(
    "a departed role that reappears, %s, is live again and keeps its first sighting",
    ([, relist]) =>
      Effect.gen(function* reappears() {
        const layer = yield* sqlJsJobStore;

        yield* Effect.gen(function* withStore() {
          const store = yield* JobStore;
          const role = job("greenhouse:acme:1");

          yield* store.replaceFeed(FEED, [role], NOW);
          yield* store.replaceFeed(FEED, [], NOW + DAY_MILLIS);

          const departed = yield* jobRows;

          yield* relist(role, NOW + 2 * DAY_MILLIS);

          expect(departed).toStrictEqual([
            {
              departed_at: NOW + DAY_MILLIS,
              first_seen_at: NOW,
              id: role.id,
              last_seen_at: NOW,
            },
          ]);
          expect(yield* jobRows).toStrictEqual([
            {
              departed_at: null,
              first_seen_at: NOW,
              id: role.id,
              last_seen_at: NOW + 2 * DAY_MILLIS,
            },
          ]);
          expect(yield* listedIds(NOW + 2 * DAY_MILLIS)).toStrictEqual([
            role.id,
          ]);
        }).pipe(Effect.provide(layer));
      })
  );

  it.effect(
    "a failed fetch leaves its feed's listed and departed rows untouched",
    () =>
      Effect.gen(function* failedFetch() {
        const layer = yield* sqlJsJobStore;

        yield* Effect.gen(function* withStore() {
          const store = yield* JobStore;

          yield* store.replaceFeed(
            FEED,
            [job("greenhouse:acme:1"), job("greenhouse:acme:2")],
            NOW
          );
          yield* store.replaceFeed(
            FEED,
            [job("greenhouse:acme:1", { lastSeenAt: NOW + DAY_MILLIS })],
            NOW + DAY_MILLIS
          );

          const before = yield* jobRows;

          yield* TestClock.setTime(NOW + 2 * DAY_MILLIS);

          const feed: FeedRef = {
            company: Option.some("Acme"),
            key: FEED,
            minIntervalMinutes: 1,
            source: "Greenhouse",
          };

          const run = yield* runIngest({
            feedConcurrency: 1,
            feedsPerRun: 1,
          }).pipe(
            Effect.provideService(
              PostingFeeds,
              PostingFeeds.of({
                catalog: [feed],
                fetch: () =>
                  Effect.fail(
                    new FeedUnavailable({ feed: FEED, message: "Unavailable" })
                  ),
              })
            )
          );

          expect(run.receipt).toMatchObject({
            feedsFailed: 1,
            outcome: "Failed",
          });
          expect(before.map(({ departed_at }) => departed_at)).toStrictEqual([
            null,
            NOW + DAY_MILLIS,
          ]);
          expect(yield* jobRows).toStrictEqual(before);
        }).pipe(Effect.provide(layer));
      })
  );

  it.effect("migration 0012 leaves rows written before it on the board", () =>
    Effect.gen(function* migrationKeepsRowsLive() {
      const layer = yield* seededSqlJsJobStore({
        "0011_tracker_storage.sql": `INSERT INTO jobs (id, feed, source, title, company, location, region, arrangement, role, url, salary, relevance, posted_at, first_seen_at, last_seen_at, fingerprint, company_slug) VALUES
  ('greenhouse:acme:1', '${FEED}', 'Greenhouse', 'Engineering Manager', 'Acme', 'Remote', 'RemoteCanada', 'Remote', 'EngineeringManager', 'https://jobs.example/1', NULL, 50, ${NOW - 3 * DAY_MILLIS}, ${NOW - 3 * DAY_MILLIS}, ${NOW}, 'acme|engineeringmanager', 'acme'),
  ('greenhouse:acme:2', '${FEED}', 'Greenhouse', 'Director of Engineering', 'Acme', 'Remote', 'RemoteCanada', 'Remote', 'Director', 'https://jobs.example/2', NULL, 50, ${NOW - 9 * DAY_MILLIS}, ${NOW - 9 * DAY_MILLIS}, ${NOW - DAY_MILLIS}, 'acme|director', 'acme');`,
      });

      const { listed, rows } = yield* Effect.gen(function* readMigrated() {
        return {
          listed: yield* listedIds(NOW),
          rows: yield* jobRows,
        };
      }).pipe(Effect.provide(layer));

      expect(
        rows.map(({ departed_at, id }) => [id, departed_at])
      ).toStrictEqual([
        ["greenhouse:acme:1", null],
        ["greenhouse:acme:2", null],
      ]);
      expect(listed).toStrictEqual(["greenhouse:acme:1", "greenhouse:acme:2"]);
    })
  );

  it.effect(
    `marks a feed listed in statements of at most ${UPSERT_CHUNK} ids, however many it lists`,
    () =>
      Effect.gen(function* chunkedMarkListed() {
        const layer = yield* sqlJsJobStore;

        const roles = Array.makeBy(2 * UPSERT_CHUNK + 1, (index) =>
          job(`greenhouse:acme:${index}`)
        );

        yield* Effect.gen(function* withStore() {
          const sql = yield* SqlExecutor;
          const batches: (readonly SqlStatement[])[] = [];

          const store = yield* makeJobStore.pipe(
            Effect.provideService(
              SqlExecutor,
              SqlExecutor.of({
                ...sql,
                batch: (operation, statements) => {
                  if (operation === "markListed") {
                    batches.push(statements);
                  }

                  return sql.batch(operation, statements);
                },
              })
            )
          );

          yield* store.replaceFeed(FEED, roles, NOW);
          yield* store.replaceFeed(FEED, [], NOW + DAY_MILLIS);
          yield* store.markListed(
            FEED,
            roles.map(({ id }) => id),
            NOW + 2 * DAY_MILLIS
          );
          yield* store.replaceFeed(FEED, [], NOW + 2 * DAY_MILLIS);

          const marked = batches
            .flat()
            .map(({ params }) =>
              Schema.decodeUnknownSync(
                Schema.fromJsonString(Schema.Array(Schema.String))
              )(params.at(-1))
            );

          expect(marked.map((ids) => ids.length)).toStrictEqual([
            UPSERT_CHUNK,
            UPSERT_CHUNK,
            1,
          ]);
          expect(marked.flat()).toStrictEqual(roles.map(({ id }) => id));
          expect(
            (yield* jobRows).filter(({ departed_at }) => departed_at !== null)
          ).toStrictEqual([]);
          expect(yield* listedIds(NOW + 2 * DAY_MILLIS)).toHaveLength(
            roles.length
          );
        }).pipe(Effect.provide(layer));
      })
  );
});
