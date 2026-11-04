import { describe, expect, it } from "@effect/vitest";
import {
  DAY_MILLIS,
  FeedUnavailable,
  JobStore,
  MAX_AGE_DAYS,
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
  it.effect(
    "the board counts a long-open role as open but not as new today",
    () =>
      Effect.gen(function* longOpenStats() {
        const layer = yield* sqlJsJobStore;

        yield* Effect.gen(function* withStore() {
          const store = yield* JobStore;

          yield* store.replaceFeed(
            FEED,
            [
              job("greenhouse:acme:1", {
                company: "Fresh Co",
              }),
              job("greenhouse:acme:2", {
                company: "Long Open Co",
                postedAt: NOW - 106 * DAY_MILLIS,
              }),
            ],
            NOW
          );

          const stats = yield* store.stats(NOW, SourceName.literals, [FEED]);

          const page = yield* store.list(
            {
              limit: 10,
              maxAgeDays: MAX_AGE_DAYS,
              offset: 0,
              regions: [],
              roles: [],
              salaryFloor: null,
              salaryListed: false,
              search: "",
              seniorities: [],
              sort: "Relevance",
            },
            NOW,
            SourceName.literals
          );

          expect([stats.activeJobs, stats.newToday]).toStrictEqual([2, 1]);
          expect(page.jobs.map((listed) => listed.company)).toStrictEqual([
            "Fresh Co",
            "Long Open Co",
          ]);
        }).pipe(Effect.provide(layer));
      })
  );

  it.effect(
    "an absent aggregator row departs only once its posting is older than the cutoff",
    () =>
      Effect.gen(function* holdsAggregatorRow() {
        const layer = yield* sqlJsJobStore;

        yield* Effect.gen(function* withStore() {
          const store = yield* JobStore;
          const feed = "jobicy:engineering-manager";
          const held = job(`${feed}:1`, { feed, source: "Jobicy" });

          yield* store.replaceFeed(feed, [held], NOW);

          const first = yield* store.replaceFeed(
            feed,
            [],
            NOW + DAY_MILLIS,
            NOW
          );

          const second = yield* store.replaceFeed(
            feed,
            [],
            NOW + 2 * DAY_MILLIS,
            NOW + 1
          );

          expect([first.departed, second.departed]).toStrictEqual([0, 1]);
          expect(yield* jobRows).toStrictEqual([
            {
              departed_at: NOW + 2 * DAY_MILLIS,
              first_seen_at: NOW,
              id: held.id,
              last_seen_at: NOW,
            },
          ]);
        }).pipe(Effect.provide(layer));
      })
  );

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
            coverage: "Complete",
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

  it.effect(
    "a feed dropped from the catalog is never fetched, leaves feed health at once, and its rows age out after 30 days unseen",
    () =>
      Effect.gen(function* retiredFeed() {
        const layer = yield* sqlJsJobStore;

        const retired = "smartrecruiters:Experian";

        const kept: FeedRef = {
          company: Option.some("Acme"),
          coverage: "Complete",
          key: FEED,
          minIntervalMinutes: 1,
          source: "Greenhouse",
        };

        const fetched: string[] = [];

        const ingest = runIngest({ feedConcurrency: 1, feedsPerRun: 30 }).pipe(
          Effect.provideService(
            PostingFeeds,
            PostingFeeds.of({
              catalog: [kept],
              fetch: (feed) =>
                Effect.sync(() => {
                  fetched.push(feed.key);

                  return [];
                }),
            })
          )
        );

        yield* Effect.gen(function* withStore() {
          const store = yield* JobStore;

          yield* store.replaceFeed(
            retired,
            [
              job(`${retired}:1`, {
                company: "Experian",
                feed: retired,
                source: "SmartRecruiters",
              }),
            ],
            NOW
          );

          yield* TestClock.setTime(NOW + 29 * DAY_MILLIS);

          const early = yield* ingest;

          const stats = yield* store.stats(
            NOW + 29 * DAY_MILLIS,
            SourceName.literals,
            [FEED]
          );

          expect(early.receipt).toMatchObject({
            feedsFailed: 0,
            jobsPruned: 0,
            outcome: "Succeeded",
          });
          expect(yield* listedIds(NOW + 29 * DAY_MILLIS)).toStrictEqual([
            `${retired}:1`,
          ]);
          expect([stats.feedsTotal, stats.feedsFailing]).toStrictEqual([1, 0]);

          yield* TestClock.setTime(NOW + 30 * DAY_MILLIS + 1);

          const late = yield* ingest;

          expect(fetched).toStrictEqual([FEED, FEED]);
          expect(late.receipt).toMatchObject({
            feedsFailed: 0,
            jobsPruned: 1,
            outcome: "Succeeded",
          });
          expect(yield* jobRows).toStrictEqual([]);
          expect(
            Option.isSome(
              yield* store.historyOf({
                company: "Experian",
                title: `Engineering Manager ${retired}:1`,
              })
            )
          ).toBe(true);
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
