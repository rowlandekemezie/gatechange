import { describe, expect, it } from "@effect/vitest";
import {
  companyIntelOf,
  DAY_MILLIS,
  JobStore,
  PostingFeeds,
  runIngest,
  ShownTrend,
} from "@rat-stack/core";
import type { FeedRef, JobQueryValue, PostingValue } from "@rat-stack/core";
import { Array, Effect, Option } from "effect";
import { TestClock } from "effect/testing";

import type { SqlExecutor } from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const BOARD = "greenhouse:acme-cloud";

const REMOTIVE = "remotive:engineering";

const catalog: readonly FeedRef[] = [
  {
    company: Option.some("Acme Cloud"),
    key: BOARD,
    minIntervalMinutes: 1,
    source: "Greenhouse",
  },
  {
    company: Option.none(),
    key: REMOTIVE,
    minIntervalMinutes: 1,
    source: "Remotive",
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

const ingestAt = (
  day: number,
  board: readonly PostingValue[],
  remotive: readonly PostingValue[] = [remotiveHead]
) =>
  Effect.gen(function* ingestDay() {
    yield* TestClock.setTime(NOW + day * DAY_MILLIS);

    const listed = new Map([
      [BOARD, board],
      [REMOTIVE, remotive],
    ]);

    return yield* runIngest({ feedConcurrency: 1, feedsPerRun: 2 }).pipe(
      Effect.provideService(
        PostingFeeds,
        PostingFeeds.of({
          catalog,
          fetch: (feed) => Effect.succeed(listed.get(feed.key) ?? []),
        })
      )
    );
  });

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

describe("company records on the SQL store", () => {
  it.effect(
    "give days open, reposts from history, a trend and bands, without Remotive data or a look-alike company",
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

          const now = NOW + 29 * DAY_MILLIS;

          const intel = companyIntelOf(
            "acme-cloud",
            yield* store.companyRecords("acme-cloud", now),
            now
          );

          expect(intel).toStrictEqual({
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
                daysOpen: 29,
                id: idOf("VP Engineering"),
                reposts: 2,
                role: "VicePresident",
                title: "VP Engineering",
              },
            ],
            trackedSince: NOW,
            trend: ShownTrend.make({
              weeks: [3, 2, 1, 0].map((weeksAgo) => ({
                open: 2,
                weekEnding: NOW + (29 - 7 * weeksAgo) * DAY_MILLIS,
              })),
            }),
          });
        })
      )
  );
});
