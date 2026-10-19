import { describe, expect, it } from "@effect/vitest";
import {
  companyIntelOf,
  DAY_MILLIS,
  JobStore,
  PostingFeeds,
  runIngest,
  ShownTrend,
  ThinTrend,
} from "@rat-stack/core";
import type { FeedRef, JobQueryValue, PostingValue } from "@rat-stack/core";
import { Array, Effect, Option, Schema } from "effect";
import { TestClock } from "effect/testing";

import { SqlExecutor, statement } from "../src/index.js";
import { trackedSinceStatement } from "../src/queries.js";
import { seededSqlJsJobStore, sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const BOARD = "greenhouse:acme-cloud";

const LOOKALIKE_BOARD = "lever:acmecloud";

const REMOTIVE = "remotive:engineering";

const HACKER_NEWS = "hackernews:who-is-hiring";

const HIMALAYAS = "himalayas:engineering";

type FeedKey =
  | typeof BOARD
  | typeof HACKER_NEWS
  | typeof HIMALAYAS
  | typeof LOOKALIKE_BOARD
  | typeof REMOTIVE;

const catalog: readonly FeedRef[] = [
  {
    company: Option.some("Acme Cloud"),
    key: BOARD,
    minIntervalMinutes: 1,
    source: "Greenhouse",
  },
  {
    company: Option.some("AcmeCloud"),
    key: LOOKALIKE_BOARD,
    minIntervalMinutes: 1,
    source: "Lever",
  },
  {
    company: Option.none(),
    key: REMOTIVE,
    minIntervalMinutes: 1,
    source: "Remotive",
  },
  {
    company: Option.none(),
    key: HACKER_NEWS,
    minIntervalMinutes: 1,
    source: "HackerNews",
  },
  {
    company: Option.none(),
    key: HIMALAYAS,
    minIntervalMinutes: 1,
    source: "Himalayas",
  },
];

const posting = (
  externalId: string,
  title: string,
  company = "Acme Cloud"
): PostingValue => ({
  company,
  externalId,
  location: "Remote - Canada",
  postedAt: null,
  salary: null,
  title,
  url: `https://jobs.example/${externalId}`,
  workplace: "Remote",
});

const vp = posting("vp", "VP Engineering");

const director = posting("dir", "Director of Platform");

const manager = posting("em", "Engineering Manager, Billing");

const lookalike = posting("other", "VP Engineering", "Acme Cloudy");

const remotiveHead = posting("rm", "Head of Engineering");

const ingestListing = (
  day: number,
  listed: Partial<Record<FeedKey, readonly PostingValue[]>>
) =>
  Effect.gen(function* ingestDay() {
    yield* TestClock.setTime(NOW + day * DAY_MILLIS);

    return yield* runIngest({
      feedConcurrency: 1,
      feedsPerRun: catalog.length,
    }).pipe(
      Effect.provideService(
        PostingFeeds,
        PostingFeeds.of({
          catalog,
          fetch: (feed) =>
            Effect.succeed(
              new Map(Object.entries(listed)).get(feed.key) ?? Array.empty()
            ),
        })
      )
    );
  });

const ingestAt = (
  day: number,
  board: readonly PostingValue[],
  remotive: readonly PostingValue[] = [remotiveHead]
) => ingestListing(day, { [BOARD]: board, [REMOTIVE]: remotive });

const everything: JobQueryValue = {
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

const withStore = <A, E>(body: Effect.Effect<A, E, JobStore | SqlExecutor>) =>
  Effect.gen(function* provideStore() {
    const layer = yield* sqlJsJobStore;

    return yield* body.pipe(Effect.provide(layer));
  });

const intelOn = (day: number) =>
  Effect.gen(function* intelOnDay() {
    const now = NOW + day * DAY_MILLIS;
    const store = yield* JobStore;

    return companyIntelOf(
      "acme-cloud",
      yield* store.companyRecords("acme-cloud", now),
      now
    );
  });

const weeksEndingOn = (day: number, open: readonly number[]) =>
  open.map((count, index) => ({
    open: count,
    weekEnding: NOW + (day - 7 * (open.length - 1 - index)) * DAY_MILLIS,
  }));

describe("company records on the SQL store", () => {
  it.effect(
    "give days open in the current stint, reposts from history, a trend and bands, without Remotive data or a look-alike company",
    () =>
      withStore(
        Effect.gen(function* companyRecords() {
          yield* ingestAt(0, [vp, director, manager, lookalike]);
          yield* ingestAt(1, [vp, director, lookalike]);
          yield* ingestAt(2, [director, lookalike]);
          yield* ingestAt(10, [vp, director, lookalike]);
          yield* ingestAt(11, [vp, director, lookalike]);
          yield* ingestAt(12, [director, lookalike]);
          yield* ingestAt(20, [vp, director, lookalike]);
          yield* ingestAt(29, [vp, director, lookalike]);

          const store = yield* JobStore;
          const listed = yield* store.list(everything, NOW + 29 * DAY_MILLIS);

          const idOf = (title: string, company = "Acme Cloud") =>
            Option.getOrThrow(
              Array.findFirst(
                listed.jobs,
                (job) => job.title === title && job.company === company
              )
            ).id;

          yield* Effect.forEach(
            [
              [idOf("VP Engineering"), 300_000, 360_000],
              [idOf("Director of Platform"), 220_000, 260_000],
              [idOf("Head of Engineering"), 900_000, 999_000],
            ] as const,
            ([id, min, max]) =>
              store.saveEnrichment(id, {
                enrichedAt: NOW,
                model: "fixture",
                remotePolicy: null,
                reportsTo: null,
                salary: { currency: "USD", max, min },
                seniority: null,
                teamSize: null,
              }),
            { discard: true }
          );

          expect(yield* intelOn(29)).toStrictEqual({
            bands: [{ currency: "USD", max: 310_000, min: 260_000, roles: 2 }],
            roles: [
              {
                daysOpen: 29,
                id: idOf("Director of Platform"),
                reposts: 0,
                role: "Director",
                title: "Director of Platform",
              },
              {
                daysOpen: 9,
                id: idOf("VP Engineering"),
                reposts: 2,
                role: "VicePresident",
                title: "VP Engineering",
              },
            ],
            trackedSince: NOW,
            trend: ShownTrend.make({ weeks: weeksEndingOn(29, [1, 2, 2, 2]) }),
          });
        })
      )
  );

  it.effect(
    "count only company-board sightings when Remotive listed the same role first",
    () =>
      withStore(
        Effect.gen(function* sameRoleAcrossSources() {
          const remotiveVp = posting("rm-vp", "VP Engineering");

          yield* ingestAt(0, [director, manager], [remotiveVp]);
          yield* ingestAt(1, [director, manager], [remotiveVp]);
          yield* ingestAt(5, [director, manager], []);
          yield* ingestAt(6, [director, manager], []);
          yield* ingestAt(10, [director, manager], [remotiveVp]);
          yield* ingestAt(11, [director, manager], [remotiveVp]);
          yield* ingestAt(20, [director, manager], []);
          yield* ingestAt(21, [director, manager], []);
          yield* ingestAt(28, [vp, director, manager], []);
          yield* ingestAt(29, [vp, director, manager], []);

          const intel = yield* intelOn(29);

          expect(
            intel.roles.map(({ daysOpen, reposts, title }) => ({
              daysOpen,
              reposts,
              title,
            }))
          ).toStrictEqual([
            { daysOpen: 29, reposts: 0, title: "Director of Platform" },
            {
              daysOpen: 29,
              reposts: 0,
              title: "Engineering Manager, Billing",
            },
            { daysOpen: 1, reposts: 0, title: "VP Engineering" },
          ]);
          expect(intel.trend).toStrictEqual(
            ShownTrend.make({ weeks: weeksEndingOn(29, [2, 2, 2, 3]) })
          );
        })
      )
  );

  it.effect(
    "track history from the first sighting, so roles open for 90 days fill 12 trend weeks",
    () =>
      withStore(
        Effect.gen(function* longOpenRoles() {
          const fourRoles = [
            vp,
            director,
            manager,
            posting("head", "Head of Engineering"),
          ] as const;

          yield* Effect.forEach(
            Array.makeBy(16, (run) => run * 6),
            (day) => ingestAt(day, fourRoles, []),
            { discard: true }
          );

          const intel = yield* intelOn(90);

          expect(intel.trackedSince).toBe(NOW);
          expect(intel.trend).toStrictEqual(
            ShownTrend.make({
              weeks: weeksEndingOn(
                90,
                Array.makeBy(12, () => 4)
              ),
            })
          );
        })
      )
  );

  it.effect(
    "count days open from the latest reopening and leave closed weeks out of the trend",
    () =>
      withStore(
        Effect.gen(function* reopenedRole() {
          const others = [
            director,
            manager,
            posting("head", "Head of Engineering"),
          ] as const;

          yield* Effect.forEach(
            Array.makeBy(16, (run) => run * 6),
            (day) =>
              ingestAt(
                day,
                day <= 36 || day === 90 ? [vp, ...others] : others,
                []
              ),
            { discard: true }
          );

          const intel = yield* intelOn(90);

          expect(
            Array.findFirst(
              intel.roles,
              (role) => role.title === "VP Engineering"
            )
          ).toStrictEqual(
            Option.some({
              daysOpen: 0,
              id: `${BOARD}:vp`,
              reposts: 1,
              role: "VicePresident",
              title: "VP Engineering",
            })
          );
          expect(intel.trend).toStrictEqual(
            ShownTrend.make({
              weeks: weeksEndingOn(90, [4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 4]),
            })
          );
        })
      )
  );

  it.effect(
    "keep another company whose name shares the slug's letters out of the history",
    () =>
      withStore(
        Effect.gen(function* exactCompany() {
          yield* ingestListing(0, {
            [BOARD]: [vp, director],
            [LOOKALIKE_BOARD]: [
              posting("ac", "Director of Engineering", "AcmeCloud"),
            ],
          });

          expect((yield* intelOn(0)).trend).toStrictEqual(
            ThinTrend.make({ roles: 2, weeks: 0 })
          );
        })
      )
  );

  it.effect(
    "keep a role Hacker News and an allowed aggregator both list in Pro intel",
    () =>
      withStore(
        Effect.gen(function* allowedDuplicate() {
          const head = posting("head", "Head of Engineering");

          yield* ingestListing(0, {
            [BOARD]: [vp],
            [HACKER_NEWS]: [head],
            [HIMALAYAS]: [head],
          });

          expect(
            (yield* intelOn(0)).roles.map((role) => role.id).toSorted()
          ).toStrictEqual([`${BOARD}:vp`, `${HIMALAYAS}:head`]);
        })
      )
  );

  it.effect(
    "migration 0010 backfills intel history from allowed sources only",
    () =>
      Effect.gen(function* backfill() {
        const row = (
          id: string,
          feed: string,
          source: string,
          firstDaysAgo: number,
          lastDaysAgo: number
        ) =>
          `('${id}', '${feed}', '${source}', 'VP Engineering', 'Acme Cloud', 'Remote', 'RemoteCanada', 'Remote', 'VicePresident', 'https://jobs.example/${id}', NULL, 50, ${NOW - firstDaysAgo * DAY_MILLIS}, ${NOW - firstDaysAgo * DAY_MILLIS}, ${NOW - lastDaysAgo * DAY_MILLIS}, 'acmecloud|vpengineering')`;

        const layer = yield* seededSqlJsJobStore({
          "0001_jobs.sql": `INSERT INTO jobs (id, feed, source, title, company, location, region, arrangement, role, url, salary, relevance, posted_at, first_seen_at, last_seen_at, fingerprint) VALUES
  ${row("rm:1", REMOTIVE, "Remotive", 20, 0)},
  ${row("hn:1", HACKER_NEWS, "HackerNews", 25, 0)},
  ${row("gh:1", BOARD, "Greenhouse", 3, 0)};`,
        });

        const records = yield* JobStore.use((store) =>
          store.companyRecords("acme-cloud", NOW)
        ).pipe(Effect.provide(layer));

        expect(records.history).toStrictEqual([
          {
            company: "Acme Cloud",
            feed: BOARD,
            stints: [{ from: NOW - 3 * DAY_MILLIS, until: NOW }],
          },
        ]);
        expect(records.trackedSince).toBe(NOW - 3 * DAY_MILLIS);
      })
  );

  it.effect("find when tracking began through an index, not a table scan", () =>
    withStore(
      Effect.gen(function* trackedSincePlan() {
        const plan = yield* SqlExecutor.use((sql) =>
          sql.all(
            "explainTrackedSince",
            statement(
              `EXPLAIN QUERY PLAN ${trackedSinceStatement.sql}`,
              trackedSinceStatement.params
            ),
            Schema.Struct({ detail: Schema.String })
          )
        );

        expect(plan.map((step) => step.detail)).toStrictEqual([
          "SEARCH intel_history USING COVERING INDEX intel_history_first_seen",
        ]);
      })
    )
  );
});
