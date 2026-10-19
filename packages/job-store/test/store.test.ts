import { describe, expect, it } from "@effect/vitest";
import { DAY_MILLIS, JobStore } from "@rat-stack/core";
import type { JobQueryValue, JobValue } from "@rat-stack/core";
import { Array, Effect, Option, pipe } from "effect";

import { seededSqlJsJobStore, sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const job = (
  overrides: Partial<JobValue> & Pick<JobValue, "id" | "feed">
): JobValue => ({
  arrangement: "Remote",
  company: "Acme",
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  location: "Remote - Canada",
  postedAt: NOW,
  region: "RemoteCanada",
  relevance: 50,
  role: "EngineeringManager",
  salary: null,
  source: "Greenhouse",
  title: "Engineering Manager",
  url: "https://jobs.example/1",
  ...overrides,
});

const query = (overrides: Partial<JobQueryValue> = {}): JobQueryValue => ({
  limit: 50,
  maxAgeDays: 30,
  offset: 0,
  regions: [],
  roles: [],
  salaryListed: false,
  search: "",
  sort: "Newest",
  ...overrides,
});

const withStore = <A, E>(body: Effect.Effect<A, E, JobStore>) =>
  Effect.gen(function* runWithStore() {
    const layer = yield* sqlJsJobStore;

    return yield* body.pipe(Effect.provide(layer));
  });

const history = (
  firstSeenAt: number,
  lastSeenAt: number,
  sightings: number,
  reposts: number
) => Option.some({ firstSeenAt, lastSeenAt, reposts, sightings });

const ids = (jobs: readonly JobValue[]) =>
  pipe(
    jobs,
    Array.map((found) => found.id)
  ).toSorted();

describe("D1 job store queries", () => {
  it.effect(
    "replacing a feed keeps listed jobs, drops unlisted ones, and leaves other feeds alone",
    () =>
      withStore(
        Effect.gen(function* replaceFeeds() {
          const store = yield* JobStore;

          yield* store.replaceFeed(
            "a",
            [
              job({ feed: "a", id: "a:1" }),
              job({ feed: "a", id: "a:2", title: "Director of Engineering" }),
            ],
            NOW
          );
          yield* store.replaceFeed(
            "b",
            [job({ company: "Globex", feed: "b", id: "b:1" })],
            NOW
          );

          const replaced = yield* store.replaceFeed(
            "a",
            [
              job({
                feed: "a",
                firstSeenAt: NOW + 10,
                id: "a:2",
                lastSeenAt: NOW + 10,
                postedAt: NOW + 10,
                title: "Director of Engineering",
              }),
            ],
            NOW + 10
          );

          const listing = yield* store.list(query(), NOW + 20);

          expect(replaced).toStrictEqual({ removed: 1, upserted: 1 });
          expect(ids(listing.jobs)).toStrictEqual(["a:2", "b:1"]);

          const kept = pipe(
            Array.findFirst(listing.jobs, (found) => found.id === "a:2"),
            Option.map((found) => [found.firstSeenAt, found.postedAt])
          );

          expect(kept).toStrictEqual(Option.some([NOW, NOW]));
        })
      )
  );

  it.effect(
    "the same role from a company board and an aggregator is listed once, from the board",
    () =>
      withStore(
        Effect.gen(function* dedupe() {
          const store = yield* JobStore;

          yield* store.replaceFeed(
            "remoteok:all",
            [
              job({
                feed: "remoteok:all",
                id: "r:1",
                source: "RemoteOK",
                title: "Engineering  Manager",
              }),
            ],
            NOW
          );
          yield* store.replaceFeed(
            "greenhouse:acme",
            [job({ feed: "greenhouse:acme", id: "g:1" })],
            NOW
          );

          const listing = yield* store.list(query(), NOW);

          expect(ids(listing.jobs)).toStrictEqual(["g:1"]);
          expect(listing.total).toBe(1);
        })
      )
  );

  it.effect(
    "filters respect age, role, region and a search containing LIKE wildcards",
    () =>
      withStore(
        Effect.gen(function* filter() {
          const store = yield* JobStore;

          yield* store.replaceFeed(
            "a",
            [
              job({
                feed: "a",
                id: "a:old",
                postedAt: NOW - 10 * DAY_MILLIS,
                title: "Old Engineering Manager",
              }),
              job({
                feed: "a",
                id: "a:vp",
                role: "VicePresident",
                title: "VP Engineering",
              }),
              job({
                company: "100%_Co",
                feed: "a",
                id: "a:bc",
                region: "BritishColumbia",
                title: "EM Platform",
              }),
            ],
            NOW
          );

          const week = yield* store.list(query({ maxAgeDays: 7 }), NOW);

          const vp = yield* store.list(
            query({ roles: ["VicePresident"] }),
            NOW
          );

          const bc = yield* store.list(
            query({ regions: ["BritishColumbia"] }),
            NOW
          );

          const search = yield* store.list(query({ search: "100%_" }), NOW);

          expect(ids(week.jobs)).toStrictEqual(["a:bc", "a:vp"]);
          expect(ids(vp.jobs)).toStrictEqual(["a:vp"]);
          expect(ids(bc.jobs)).toStrictEqual(["a:bc"]);
          expect(ids(search.jobs)).toStrictEqual(["a:bc"]);
        })
      )
  );

  it.effect(
    "relevance ranks a fresh role above a stale one with the same score",
    () =>
      withStore(
        Effect.gen(function* rank() {
          const store = yield* JobStore;

          yield* store.replaceFeed(
            "a",
            [
              job({
                feed: "a",
                id: "a:stale",
                postedAt: NOW - 5 * DAY_MILLIS,
                title: "Engineering Manager, Data",
              }),
              job({
                feed: "a",
                id: "a:fresh",
                title: "Engineering Manager, Growth",
              }),
            ],
            NOW
          );

          const listing = yield* store.list(query({ sort: "Relevance" }), NOW);

          expect(
            pipe(
              listing.jobs,
              Array.map((found) => found.id)
            )
          ).toStrictEqual(["a:fresh", "a:stale"]);
        })
      )
  );

  it.effect(
    "pruning removes roles past the retention window and failures accumulate on a feed",
    () =>
      withStore(
        Effect.gen(function* prune() {
          const store = yield* JobStore;

          yield* store.replaceFeed(
            "a",
            [
              job({ feed: "a", id: "a:1", postedAt: NOW - 40 * DAY_MILLIS }),
              job({ feed: "a", id: "a:2" }),
            ],
            NOW
          );

          const pruned = yield* store.pruneOlderThan(NOW - 30 * DAY_MILLIS);

          yield* store.recordFeedFailure("b", NOW, "timeout");
          yield* store.recordFeedFailure("b", NOW + 1, "timeout");

          const states = yield* store.feedStates;
          const stats = yield* store.stats(NOW);

          expect(pruned).toBe(1);
          expect(
            pipe(
              states,
              Array.map((state) => [state.key, state.consecutiveFailures])
            )
          ).toStrictEqual([
            ["a", 0],
            ["b", 2],
          ]);
          expect([
            stats.activeJobs,
            stats.feedsTotal,
            stats.feedsFailing,
          ]).toStrictEqual([1, 2, 1]);
        })
      )
  );

  it.effect(
    "pruning past the retention window keeps the history of every pruned role",
    () =>
      withStore(
        Effect.gen(function* pruneKeepsHistory() {
          const store = yield* JobStore;
          const expired = job({ feed: "a", id: "a:1", title: "Director" });

          yield* store.replaceFeed("a", [expired], NOW - 40 * DAY_MILLIS);
          yield* store.pruneOlderThan(NOW + DAY_MILLIS);

          const listing = yield* store.list(query(), NOW);
          const kept = yield* store.historyOf(expired);

          expect(listing.total).toBe(0);
          expect(kept).toStrictEqual(
            history(NOW - 40 * DAY_MILLIS, NOW - 40 * DAY_MILLIS, 1, 0)
          );
        })
      )
  );

  it.effect(
    "an older run that finishes late never moves a listing's last sighting back",
    () =>
      withStore(
        Effect.gen(function* overlappingRuns() {
          const store = yield* JobStore;
          const late = NOW + DAY_MILLIS;

          yield* store.replaceFeed(
            "a",
            [job({ feed: "a", id: "a:1", lastSeenAt: late })],
            late
          );
          yield* store.replaceFeed("a", [job({ feed: "a", id: "a:1" })], NOW);

          const listing = yield* store.list(query(), late);

          expect(
            pipe(
              listing.jobs,
              Array.map((found) => [found.id, found.lastSeenAt])
            )
          ).toStrictEqual([["a:1", late]]);
          expect(
            yield* store.historyOf(job({ feed: "a", id: "a:1" }))
          ).toStrictEqual(history(NOW, late, 1, 0));
        })
      )
  );

  it.effect(
    "one role listed by a board and an aggregator in the same run is one sighting of one history row",
    () =>
      withStore(
        Effect.gen(function* dedupeHistory() {
          const store = yield* JobStore;
          const role = job({ feed: "greenhouse:acme", id: "g:1" });

          yield* store.replaceFeed("greenhouse:acme", [role], NOW);
          yield* store.replaceFeed(
            "remoteok:all",
            [
              job({
                feed: "remoteok:all",
                id: "r:1",
                source: "RemoteOK",
                title: "Engineering  Manager",
              }),
            ],
            NOW
          );
          yield* store.replaceFeed("remoteok:all", [], NOW + DAY_MILLIS);

          expect(yield* store.historyOf(role)).toStrictEqual(
            history(NOW, NOW, 1, 0)
          );
        })
      )
  );

  it.effect(
    "migration 0002 backfills one history row per fingerprint from existing jobs",
    () =>
      Effect.gen(function* backfill() {
        const layer = yield* seededSqlJsJobStore({
          "0001_jobs.sql": `INSERT INTO jobs (id, feed, source, title, company, location, region, arrangement, role, url, salary, relevance, posted_at, first_seen_at, last_seen_at, fingerprint) VALUES
  ('g:1', 'greenhouse:acme', 'Greenhouse', 'Engineering Manager', 'Acme', 'Remote', 'RemoteCanada', 'Remote', 'EngineeringManager', 'https://jobs.example/1', NULL, 50, ${NOW - 5 * DAY_MILLIS}, ${NOW - 5 * DAY_MILLIS}, ${NOW}, 'acme|engineeringmanager'),
  ('r:1', 'remoteok:all', 'RemoteOK', 'Engineering Manager', 'Acme', 'Remote', 'RemoteCanada', 'Remote', 'EngineeringManager', 'https://jobs.example/2', NULL, 50, ${NOW - 9 * DAY_MILLIS}, ${NOW - 9 * DAY_MILLIS}, ${NOW - DAY_MILLIS}, 'acme|engineeringmanager');`,
        });

        const result = yield* Effect.gen(function* readBackfill() {
          const store = yield* JobStore;

          return {
            kept: yield* store.historyOf(job({ feed: "a", id: "a:1" })),
            listing: yield* store.list(query(), NOW),
          };
        }).pipe(Effect.provide(layer));

        expect(result.kept).toStrictEqual(
          history(NOW - 9 * DAY_MILLIS, NOW, 1, 0)
        );
        expect(
          pipe(
            result.listing.jobs,
            Array.map((found) => [found.id, found.daysOpen])
          )
        ).toStrictEqual([["g:1", 9]]);
      })
  );

  it.effect(
    "migration 0002 judges a backfilled role by the feed of its most recently seen job",
    () =>
      Effect.gen(function* backfilledLastSeenFeed() {
        const layer = yield* seededSqlJsJobStore({
          "0001_jobs.sql": `INSERT INTO jobs (id, feed, source, title, company, location, region, arrangement, role, url, salary, relevance, posted_at, first_seen_at, last_seen_at, fingerprint) VALUES
  ('g:1', 'greenhouse:acme', 'Greenhouse', 'Engineering Manager', 'Acme', 'Remote', 'RemoteCanada', 'Remote', 'EngineeringManager', 'https://jobs.example/1', NULL, 50, ${NOW - 5 * DAY_MILLIS}, ${NOW - 5 * DAY_MILLIS}, ${NOW - DAY_MILLIS}, 'acme|engineeringmanager'),
  ('r:1', 'remoteok:all', 'RemoteOK', 'Engineering Manager', 'Acme', 'Remote', 'RemoteCanada', 'Remote', 'EngineeringManager', 'https://jobs.example/2', NULL, 50, ${NOW - 9 * DAY_MILLIS}, ${NOW - 9 * DAY_MILLIS}, ${NOW}, 'acme|engineeringmanager');`,
        });

        const reposts = yield* Effect.gen(function* sightAfterBackfill() {
          const store = yield* JobStore;
          const listed = job({ feed: "greenhouse:acme", id: "g:1" });

          yield* store.replaceFeed("remoteok:all", [], NOW + DAY_MILLIS);
          yield* store.replaceFeed(
            "greenhouse:acme",
            [listed],
            NOW + 9 * DAY_MILLIS
          );

          return pipe(
            yield* store.historyOf(listed),
            Option.map((found) => found.reposts)
          );
        }).pipe(Effect.provide(layer));

        expect(reposts).toStrictEqual(Option.some(1));
      })
  );

  it.effect(
    "a job written after the backfill but before history existed keeps its first-seen date on its first sighting",
    () =>
      Effect.gen(function* migrationWindow() {
        const layer = yield* seededSqlJsJobStore({
          "0002_job_history.sql": `INSERT INTO jobs (id, feed, source, title, company, location, region, arrangement, role, url, salary, relevance, posted_at, first_seen_at, last_seen_at, fingerprint) VALUES
  ('a:1', 'a', 'Greenhouse', 'Engineering Manager', 'Acme', 'Remote', 'RemoteCanada', 'Remote', 'EngineeringManager', 'https://jobs.example/1', NULL, 50, ${NOW - 3 * DAY_MILLIS}, ${NOW - 3 * DAY_MILLIS}, ${NOW - DAY_MILLIS}, 'acme|engineeringmanager');`,
        });

        const kept = yield* Effect.gen(function* sightAfterWindow() {
          const store = yield* JobStore;
          const listed = job({ feed: "a", id: "a:1" });

          yield* store.replaceFeed("a", [listed], NOW);

          return yield* store.historyOf(listed);
        }).pipe(Effect.provide(layer));

        expect(kept).toStrictEqual(history(NOW - 3 * DAY_MILLIS, NOW, 1, 0));
      })
  );

  it.effect(
    "finding a job by id returns it while listed and nothing once its feed drops it",
    () =>
      withStore(
        Effect.gen(function* findJob() {
          const store = yield* JobStore;
          const listed = job({ feed: "a", id: "a:1", salary: "$200k" });

          yield* store.replaceFeed("a", [listed], NOW);

          const found = yield* store.find("a:1");
          const unknown = yield* store.find("a:404");

          yield* store.replaceFeed("a", [], NOW + 10);

          const dropped = yield* store.find("a:1");

          expect(found).toStrictEqual(Option.some(listed));
          expect(unknown).toStrictEqual(Option.none());
          expect(dropped).toStrictEqual(Option.none());
        })
      )
  );
});
