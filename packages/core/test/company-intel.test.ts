import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  companyIntelOf,
  companySlugOf,
  companySummaryOf,
  JobStore,
  ShownTrend,
  SourceName,
  sourceOfFeedKey,
  ThinTrend,
} from "../src/index.js";
import type {
  CompanyRecords,
  HistoryRecord,
  OpenRoleRecord,
} from "../src/index.js";
import { makeMemoryJobStore } from "./memory-job-store.js";

const DAY = 86_400_000;

const NOW = 1_790_000_000_000;

const open = (
  overrides: Partial<OpenRoleRecord> & Pick<OpenRoleRecord, "id" | "title">
): OpenRoleRecord => ({
  company: "Acme Cloud",
  openedAt: NOW - DAY,
  reposts: 0,
  role: "Director",
  salary: null,
  source: "Greenhouse",
  ...overrides,
});

const seen = (
  feed: string,
  firstDaysAgo: number,
  lastDaysAgo: number,
  company = "Acme Cloud"
) =>
  ({
    company,
    feed,
    stints: [
      { from: NOW - firstDaysAgo * DAY, until: NOW - lastDaysAgo * DAY },
    ],
  }) satisfies HistoryRecord;

const acme: CompanyRecords = {
  history: [
    seen("greenhouse:acme-cloud", 45, 0),
    seen("lever:acme", 10, 0),
    seen("greenhouse:acme-cloud", 80, 50),
    seen("remotive:engineering", 20, 0),
    seen("greenhouse:acme-cloud", 120, 95),
    seen("ashby:acme", 3, 0),
  ],
  open: [
    open({
      id: "gh-vp",
      openedAt: NOW - 45 * DAY,
      reposts: 2,
      role: "VicePresident",
      salary: { currency: "USD", max: 360_000, min: 300_000 },
      title: "VP Engineering",
    }),
    open({
      id: "lv-dir",
      openedAt: NOW - 10 * DAY - 3 * 3_600_000,
      salary: { currency: "USD", max: 260_000, min: 220_000 },
      source: "Lever",
      title: "Director of Platform",
    }),
    open({
      id: "rm-head",
      openedAt: NOW - 20 * DAY,
      reposts: 1,
      role: "HeadOfEngineering",
      salary: { currency: "USD", max: 999_000, min: 900_000 },
      source: "Remotive",
      title: "Head of Engineering",
    }),
    open({
      company: "AcmeCloud",
      id: "gh-other",
      title: "Director of Data",
    }),
    open({
      id: "ab-em",
      openedAt: NOW - 3 * DAY,
      role: "EngineeringManager",
      salary: { currency: "CAD", max: 240_000, min: 200_000 },
      source: "Ashby",
      title: "Engineering Manager",
    }),
  ],
  trackedSince: NOW - 100 * DAY,
};

describe("companyIntelOf", () => {
  it("builds days open, reposts, a 13-week trend and typical bands from a fixed history", () => {
    const intel = companyIntelOf("acme-cloud", acme, NOW);

    expect(intel.roles).toStrictEqual([
      {
        daysOpen: 45,
        id: "gh-vp",
        reposts: 2,
        role: "VicePresident",
        title: "VP Engineering",
      },
      {
        daysOpen: 10,
        id: "lv-dir",
        reposts: 0,
        role: "Director",
        title: "Director of Platform",
      },
      {
        daysOpen: 3,
        id: "ab-em",
        reposts: 0,
        role: "EngineeringManager",
        title: "Engineering Manager",
      },
    ]);
    expect(intel.trend).toStrictEqual(
      ShownTrend.make({
        weeks: [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 3].map((count, index) => ({
          open: count,
          weekEnding: NOW - (12 - index) * 7 * DAY,
        })),
      })
    );
    expect(intel.bands).toStrictEqual([
      { currency: "USD", max: 310_000, min: 260_000, roles: 2 },
      { currency: "CAD", max: 240_000, min: 200_000, roles: 1 },
    ]);
    expect(intel.trackedSince).toBe(NOW - 100 * DAY);
  });

  it("leaves Remotive and Hacker News data out of every Pro figure", () => {
    const intel = companyIntelOf(
      "acme-cloud",
      {
        history: [
          seen("remotive:engineering", 40, 0),
          seen("hackernews:who-is-hiring", 30, 0),
          seen("remotive:engineering", 60, 35),
        ],
        open: [
          open({
            id: "rm-1",
            salary: { currency: "USD", max: 300_000, min: 250_000 },
            source: "Remotive",
            title: "VP Engineering",
          }),
          open({ id: "hn-1", source: "HackerNews", title: "Director" }),
        ],
        trackedSince: NOW - 100 * DAY,
      },
      NOW
    );

    expect(intel).toStrictEqual({
      bands: [],
      roles: [],
      trackedSince: NOW - 100 * DAY,
      trend: ThinTrend.make({ roles: 0, weeks: 13 }),
    });
  });

  it("counts a reopened role only in the weeks of its current and previous stints", () => {
    const steady = seen("greenhouse:acme-cloud", 90, 0);

    const intel = companyIntelOf(
      "acme-cloud",
      {
        history: [
          steady,
          steady,
          {
            company: "Acme Cloud",
            feed: "greenhouse:acme-cloud",
            stints: [
              { from: NOW - 2 * DAY, until: NOW },
              { from: NOW - 90 * DAY, until: NOW - 52 * DAY },
            ],
          },
        ],
        open: [],
        trackedSince: NOW - 90 * DAY,
      },
      NOW
    );

    expect(intel.trend).toStrictEqual(
      ShownTrend.make({
        weeks: [3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 3].map((count, index) => ({
          open: count,
          weekEnding: NOW - (11 - index) * 7 * DAY,
        })),
      })
    );
  });

  it("leaves another company whose name shares the slug's letters out of the trend", () => {
    const intel = companyIntelOf(
      "acme-cloud",
      {
        history: [
          seen("greenhouse:acme-cloud", 30, 0),
          seen("greenhouse:acme-cloud", 30, 0),
          seen("lever:acmecloud", 30, 0, "AcmeCloud"),
        ],
        open: [],
        trackedSince: NOW - 30 * DAY,
      },
      NOW
    );

    expect(intel.trend).toStrictEqual(ThinTrend.make({ roles: 2, weeks: 4 }));
  });

  it("shows no trend for a company with one role", () => {
    const intel = companyIntelOf(
      "acme-cloud",
      {
        history: [seen("greenhouse:acme-cloud", 30, 0)],
        open: [open({ id: "gh-1", title: "VP Engineering" })],
        trackedSince: NOW - 100 * DAY,
      },
      NOW
    );

    expect(intel.trend).toStrictEqual(ThinTrend.make({ roles: 1, weeks: 13 }));
  });

  it("shows no trend until four weeks of history exist", () => {
    const records = (trackedDaysAgo: number): CompanyRecords => ({
      history: [1, 2, 3, 4, 5].map(() => seen("greenhouse:acme-cloud", 9, 0)),
      open: [],
      trackedSince: NOW - trackedDaysAgo * DAY,
    });

    expect(companyIntelOf("acme-cloud", records(10), NOW).trend).toStrictEqual(
      ThinTrend.make({ roles: 5, weeks: 1 })
    );
    expect(companyIntelOf("acme-cloud", records(28), NOW).trend._tag).toBe(
      "Shown"
    );
    expect(
      companyIntelOf(
        "acme-cloud",
        { history: [], open: [], trackedSince: null },
        NOW
      ).trend
    ).toStrictEqual(ThinTrend.make({ roles: 0, weeks: 0 }));
  });
});

describe("company keys", () => {
  it("uses exact company slugs while retaining punctuation and case aliases", () => {
    expect(companySlugOf("Acme Cloud")).toStrictEqual(
      Option.some("acme-cloud")
    );
    expect(companySlugOf(" ACME---Cloud ")).toStrictEqual(
      Option.some("acme-cloud")
    );
    expect(companySlugOf("AcmeCloud")).toStrictEqual(Option.some("acmecloud"));
  });

  it("reads the source back from every source's feed key prefix", () => {
    for (const source of SourceName.literals) {
      expect(sourceOfFeedKey(`${source.toLowerCase()}:any`)).toStrictEqual(
        Option.some(source)
      );
    }

    expect(sourceOfFeedKey("unknown:feed")).toStrictEqual(Option.none());
  });

  it("summarizes the open roles and the longest time one has been open", () => {
    expect(
      companySummaryOf([{ daysOpen: 4 }, { daysOpen: 64 }, { daysOpen: 0 }])
    ).toStrictEqual({ longestOpenDays: 64, openRoles: 3 });
    expect(companySummaryOf([])).toStrictEqual({
      longestOpenDays: 0,
      openRoles: 0,
    });
  });
});

it.effect(
  "memory intel partitions collisions while retaining canonical company aliases",
  () =>
    Effect.gen(function* memoryCompanyIdentity() {
      const memory = yield* makeMemoryJobStore;
      yield* Effect.gen(function* recordCompanies() {
        const store = yield* JobStore;
        yield* store.recordSightings(
          [
            {
              company: "Acme Cloud",
              feed: "greenhouse:acme",
              postedAt: NOW - 20 * DAY,
              title: "VP Engineering",
            },
          ],
          NOW - 20 * DAY
        );
        yield* store.recordSightings(
          [
            {
              company: "AcmeCloud",
              feed: "lever:other",
              postedAt: NOW,
              title: "VP Engineering",
            },
          ],
          NOW
        );
        yield* store.recordSightings(
          [
            {
              company: "ACME--Cloud",
              feed: "ashby:alias",
              postedAt: NOW,
              title: "VP Engineering",
            },
          ],
          NOW
        );
        const a = yield* store.companyRecords("acme-cloud", NOW);
        const b = yield* store.companyRecords("acmecloud", NOW);
        expect(a.history).toHaveLength(1);
        expect(a.history[0]?.stints).toStrictEqual([
          { from: NOW - 20 * DAY, until: NOW },
        ]);
        expect(b.history).toStrictEqual([
          {
            company: "AcmeCloud",
            feed: "lever:other",
            stints: [{ from: NOW, until: NOW }],
          },
        ]);
      }).pipe(Effect.provide(memory.layer));
    })
);
