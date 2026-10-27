import { describe, expect, it } from "@effect/vitest";
import {
  boardStats,
  companyJobs,
  companyJobsContract,
  DAY_MILLIS,
  JobStore,
  PostingFeeds,
  retentionAt,
  SourceName,
} from "@rat-stack/core";
import type { JobQueryValue, JobValue } from "@rat-stack/core";
import { Array, Effect, Option, pipe, Schema } from "effect";
import { TestClock } from "effect/testing";

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
  salaryFloor: null,
  salaryListed: false,
  search: "",
  seniorities: [],
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
    "exact public company lookup is bounded and counts every matching role beyond 500",
    () =>
      withStore(
        Effect.gen(function* exactCompany() {
          const store = yield* JobStore;

          const rows = Array.makeBy(510, (index) =>
            job({
              company: "Remote",
              feed: "greenhouse:remote",
              firstSeenAt:
                index === 509 ? NOW - 29 * DAY_MILLIS : NOW - index * 1000,
              id: `remote:${index}`,
              postedAt: NOW - index * 1000,
              title: `Engineering Manager ${index}`,
            })
          );

          yield* store.replaceFeed(
            "greenhouse:remote",
            [Array.getUnsafe(rows, 509)],
            NOW - 29 * DAY_MILLIS
          );
          yield* store.replaceFeed("greenhouse:remote", rows, NOW);
          yield* store.replaceFeed(
            "remotive:all",
            [
              job({
                company: "Remote",
                feed: "remotive:all",
                id: "remotive:remote",
                source: "Remotive",
                title: rows[0]?.title ?? "Engineering Manager 0",
              }),
              job({
                company: "Remote",
                feed: "remotive:all",
                id: "remotive:unique",
                source: "Remotive",
                title: "Director of Engineering",
              }),
            ],
            NOW
          );
          yield* store.replaceFeed(
            "greenhouse:other",
            [
              job({
                company: "Other",
                feed: "greenhouse:other",
                id: "other:remote",
                location: "Remote",
              }),
              job({
                company: "Remote",
                feed: "greenhouse:other",
                id: "expired",
                postedAt: NOW - 31 * DAY_MILLIS,
              }),
            ],
            NOW
          );
          yield* store.replaceFeed(
            "greenhouse:collision",
            [
              job({
                company: "A+B",
                feed: "greenhouse:collision",
                id: "collision:1",
              }),
              job({
                company: "A-B",
                feed: "greenhouse:collision",
                id: "collision:2",
                title: "Director of Engineering",
              }),
            ],
            NOW
          );
          yield* TestClock.setTime(NOW);
          const found = yield* companyJobs.handler({ slug: "remote" });
          const collision = yield* companyJobs.handler({ slug: "a-b" });
          const missing = yield* companyJobs.handler({ slug: "e-1" });

          const listed = yield* store.list(
            query({ search: "Remote" }),
            NOW,
            SourceName.literals
          );

          const encoded = yield* Schema.encodeEffect(
            companyJobsContract.output
          )(found);

          expect(found.total).toBe(511);
          expect(found.summary).toStrictEqual({
            longestOpenDays: 29,
            openRoles: 511,
          });
          expect(found.jobs).toHaveLength(12);
          expect(found.jobs.every((row) => row.company === "Remote")).toBe(
            true
          );
          expect(found.jobs.map((row) => row.id)).not.toContain(
            "remotive:remote"
          );
          expect(found.jobs.map((row) => row.id)).toContain("remotive:unique");
          expect(encoded.jobs).toHaveLength(12);
          expect(JSON.stringify(found.jobs)).not.toContain("daysOpen");
          expect(JSON.stringify(found.jobs)).not.toContain("reposts");
          expect(JSON.stringify(encoded.jobs)).not.toContain("daysOpen");
          expect(JSON.stringify(encoded.jobs)).not.toContain("reposts");
          expect(
            Schema.is(companyJobsContract.output)({
              ...found,
              jobs: [...found.jobs, ...found.jobs],
            })
          ).toBe(false);
          expect(
            Schema.is(companyJobsContract.input)({ slug: "remote%" })
          ).toBe(false);
          expect(collision.total).toBe(2);
          expect(
            collision.jobs.map((row) => row.company).toSorted()
          ).toStrictEqual(["A+B", "A-B"]);
          expect(missing).toStrictEqual({
            generatedAt: NOW,
            jobs: [],
            summary: { longestOpenDays: 0, openRoles: 0 },
            total: 0,
          });
          expect(listed.total).toBe(514);
          expect(companyJobsContract.annotations).toMatchObject({
            idempotent: true,
            readOnly: true,
          });
        })
      )
  );

  it.effect(
    "replacing a feed keeps listed jobs, takes unlisted ones off the board, and leaves other feeds alone",
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

          const listing = yield* store.list(
            query(),
            NOW + 20,
            SourceName.literals
          );

          expect(replaced).toStrictEqual({ departed: 1, upserted: 1 });
          expect(
            pipe(
              listing.jobs,
              Array.map((found) => [found.id, found.status])
            )
          ).toStrictEqual([
            ["a:2", "new"],
            ["b:1", "new"],
          ]);
          expect(listing.total).toBe(2);

          const kept = pipe(
            Array.findFirst(listing.jobs, (found) => found.id === "a:2"),
            Option.map((found) => [found.firstSeenAt, found.postedAt])
          );

          expect(kept).toStrictEqual(Option.some([NOW, NOW]));
        })
      )
  );

  it.effect(
    "a departed role leaves the board, its counts and its company page while the row waits to be pruned",
    () =>
      withStore(
        Effect.gen(function* departedEverywhere() {
          const store = yield* JobStore;

          yield* store.replaceFeed(
            "greenhouse:acme",
            [
              job({
                feed: "greenhouse:acme",
                id: "g:1",
                role: "Director",
                title: "Director of Platform",
              }),
              job({
                feed: "greenhouse:acme",
                id: "g:2",
                title: "Director of Engineering",
              }),
            ],
            NOW
          );
          yield* store.replaceFeed(
            "greenhouse:acme",
            [
              job({
                feed: "greenhouse:acme",
                id: "g:2",
                lastSeenAt: NOW + 10,
                title: "Director of Engineering",
              }),
            ],
            NOW + 10
          );

          const listing = yield* store.list(
            query(),
            NOW + 20,
            SourceName.literals
          );

          const stats = yield* store.stats(NOW + 20, SourceName.literals, []);
          const company = yield* store.companyJobs("acme", NOW + 20);
          const records = yield* store.companyRecords("acme", NOW + 20);

          expect(ids(listing.jobs)).toStrictEqual(["g:2"]);
          expect(listing.total).toBe(1);
          expect([stats.activeJobs, stats.newToday]).toStrictEqual([1, 1]);
          expect(
            stats.roles.map(({ count, role }) => [role, count])
          ).toStrictEqual([["EngineeringManager", 1]]);
          expect(ids(company.jobs)).toStrictEqual(["g:2"]);
          expect([company.total, company.summary.openRoles]).toStrictEqual([
            1, 1,
          ]);
          expect(records.open.map(({ id }) => id)).toStrictEqual(["g:2"]);
          expect(Option.isSome(yield* store.findIncludingDeparted("g:1"))).toBe(
            true
          );
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

          const listing = yield* store.list(query(), NOW, SourceName.literals);

          expect(ids(listing.jobs)).toStrictEqual(["g:1"]);
          expect(listing.total).toBe(1);
        })
      )
  );

  it.effect(
    "stats count open roles by role and region and rank companies by open roles",
    () =>
      withStore(
        Effect.gen(function* directory() {
          const store = yield* JobStore;

          yield* store.replaceFeed(
            "a",
            [
              job({ feed: "a", id: "a:1", title: "EM Payments" }),
              job({ feed: "a", id: "a:2", title: "EM Ledger" }),
              job({
                company: "Zeta & Sons",
                feed: "a",
                id: "a:3",
                region: "BritishColumbia",
                role: "Director",
                title: "Director of Engineering",
              }),
              job({
                feed: "a",
                id: "a:old",
                postedAt: NOW - 40 * DAY_MILLIS,
                title: "Old EM",
              }),
            ],
            NOW
          );

          const stats = yield* store.stats(NOW, SourceName.literals, []);

          expect(stats.companies).toStrictEqual([
            { company: "Acme", count: 2, slug: "acme" },
            { company: "Zeta & Sons", count: 1, slug: "zeta-sons" },
          ]);
          expect(stats.placements).toStrictEqual([
            { count: 2, region: "RemoteCanada", role: "EngineeringManager" },
            { count: 1, region: "BritishColumbia", role: "Director" },
          ]);
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

          const week = yield* store.list(
            query({ maxAgeDays: 7 }),
            NOW,
            SourceName.literals
          );

          const vp = yield* store.list(
            query({ roles: ["VicePresident"] }),
            NOW,
            SourceName.literals
          );

          const bc = yield* store.list(
            query({ regions: ["BritishColumbia"] }),
            NOW,
            SourceName.literals
          );

          const search = yield* store.list(
            query({ search: "100%_" }),
            NOW,
            SourceName.literals
          );

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

          const listing = yield* store.list(
            query({ sort: "Relevance" }),
            NOW,
            SourceName.literals
          );

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
    "pruning keeps a role its feed still lists however old its posting, and failures accumulate on a feed",
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

          const pruned = yield* store.prune(retentionAt(NOW));

          yield* store.recordFeedFailure("b", NOW, "timeout");
          yield* store.recordFeedFailure("b", NOW + 1, "timeout");

          const states = yield* store.feedStates;

          const stats = yield* store.stats(NOW, SourceName.literals, [
            "a",
            "b",
          ]);

          expect(pruned).toBe(0);
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
    "feed health excludes removed boards without deleting their listings or history",
    () =>
      withStore(
        Effect.gen(function* catalogHealth() {
          const store = yield* JobStore;

          yield* store.replaceFeed(
            "greenhouse:active",
            [job({ feed: "greenhouse:active", id: "active:1" })],
            NOW
          );
          yield* store.replaceFeed(
            "greenhouse:removed",
            [
              job({
                company: "Removed",
                feed: "greenhouse:removed",
                id: "removed:1",
              }),
            ],
            NOW
          );
          yield* store.recordFeedFailure(
            "greenhouse:removed",
            NOW + 1,
            "removed board"
          );
          yield* store.recordFeedFailure(
            "remotive:engineering-manager",
            NOW + 1,
            "timeout"
          );
          const beforeStates = yield* store.feedStates;

          const beforeHistory = yield* store.historyOf({
            company: "Removed",
            title: "Engineering Manager",
          });

          const catalog = [
            "greenhouse:active",
            "remotive:engineering-manager",
            ...Array.makeBy(600, (index) => `greenhouse:unattempted-${index}`),
            `greenhouse:quote"'`,
          ];

          expect(Option.isSome(beforeHistory)).toBe(true);

          const stats = yield* store.stats(NOW, SourceName.literals, catalog);
          const empty = yield* store.stats(NOW, SourceName.literals, []);

          const repeated = yield* store.stats(NOW, SourceName.literals, [
            ...catalog,
            ...catalog,
          ]);

          expect([
            stats.feedsTotal,
            stats.feedsFailing,
            stats.activeJobs,
          ]).toStrictEqual([2, 1, 2]);
          expect([
            empty.feedsTotal,
            empty.feedsFailing,
            empty.activeJobs,
          ]).toStrictEqual([0, 0, 2]);
          expect(repeated).toStrictEqual(stats);

          const publicStats = yield* boardStats.handler({}).pipe(
            Effect.provideService(PostingFeeds, {
              catalog: catalog.map((key) => ({
                company: Option.none(),
                key,
                minIntervalMinutes: 60,
                source: "Greenhouse" as const,
              })),
              fetch: () => Effect.die("boardStats must not fetch postings"),
            })
          );

          expect([
            publicStats.feedsTotal,
            publicStats.feedsFailing,
            publicStats.activeJobs,
          ]).toStrictEqual([2, 1, 2]);
          expect(yield* store.feedStates).toStrictEqual(beforeStates);
          expect(
            yield* store.historyOf({
              company: "Removed",
              title: "Engineering Manager",
            })
          ).toStrictEqual(beforeHistory);
          expect(
            ids((yield* store.list(query(), NOW, SourceName.literals)).jobs)
          ).toStrictEqual(["active:1", "removed:1"]);
        })
      )
  );

  it.effect(
    "pruning past the retention window keeps the history of every pruned role",
    () =>
      withStore(
        Effect.gen(function* pruneKeepsHistory() {
          const store = yield* JobStore;

          const expired = job({
            feed: "a",
            id: "a:1",
            lastSeenAt: NOW - 40 * DAY_MILLIS,
            title: "Director",
          });

          yield* store.replaceFeed("a", [expired], NOW - 40 * DAY_MILLIS);
          yield* store.prune(retentionAt(NOW));

          const listing = yield* store.list(query(), NOW, SourceName.literals);
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

          const listing = yield* store.list(query(), late, SourceName.literals);

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
            listing: yield* store.list(query(), NOW, SourceName.literals),
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
    "finding a job by id returns it while listed, a departed job only when asked for, and nothing once pruned",
    () =>
      withStore(
        Effect.gen(function* findJob() {
          const store = yield* JobStore;
          const listed = job({ feed: "a", id: "a:1", salary: "$200k" });

          yield* store.replaceFeed("a", [listed], NOW);

          const found = yield* store.find("a:1");
          const unknown = yield* store.find("a:404");

          yield* store.replaceFeed("a", [], NOW + 10);

          const departed = yield* store.find("a:1");
          const asked = yield* store.findIncludingDeparted("a:1");

          yield* store.prune(retentionAt(NOW + 11 + DAY_MILLIS));

          const pruned = yield* store.find("a:1");

          expect(found).toStrictEqual(
            Option.some({ ...listed, enrichment: null })
          );
          expect(unknown).toStrictEqual(Option.none());
          expect(departed).toStrictEqual(Option.none());
          expect(asked).toStrictEqual(found);
          expect(pruned).toStrictEqual(Option.none());
        })
      )
  );
});
