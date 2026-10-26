import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_FEEDS_PER_RUN,
  INGEST_INTERVAL_MINUTES,
  selectDueFeeds,
  SourceTerms,
} from "@rat-stack/core";
import type { FeedRef, FeedStateValue } from "@rat-stack/core";
import { Option } from "effect";

import {
  boardFeed,
  companyBoards,
  feedKey,
  feedRefOf,
  feedSpecs,
} from "../src/index.js";

const MINUTE = 60_000;

const REFRESH_MINUTES = 6 * 60;

const SIMULATED_MINUTES = 24 * 60;

const longestBoardGapMinutes = (
  catalog: readonly FeedRef[],
  feedsPerRun: number
) => {
  const failing = catalog.find((feed) => Option.isSome(feed.company));
  const states = new Map<string, FeedStateValue>();
  const lastFetched = new Map<string, number>();
  let longest = 0;

  for (
    let minute = 0;
    minute <= SIMULATED_MINUTES;
    minute += INGEST_INTERVAL_MINUTES
  ) {
    const due = selectDueFeeds(
      catalog,
      [...states.values()],
      minute * MINUTE,
      feedsPerRun
    );

    for (const feed of due) {
      if (feed === failing) {
        states.set(feed.key, {
          consecutiveFailures:
            (states.get(feed.key)?.consecutiveFailures ?? 0) + 1,
          key: feed.key,
          lastAttemptAt: minute * MINUTE,
          lastError: "unavailable",
          lastSuccessAt: null,
        });
      } else {
        states.set(feed.key, {
          consecutiveFailures: 0,
          key: feed.key,
          lastAttemptAt: minute * MINUTE,
          lastError: null,
          lastSuccessAt: minute * MINUTE,
        });
        lastFetched.set(feed.key, minute);
      }
    }

    for (const feed of catalog) {
      if (Option.isSome(feed.company) && feed !== failing) {
        longest = Math.max(longest, minute - (lastFetched.get(feed.key) ?? 0));
      }
    }
  }

  return longest;
};

describe("company board registry", () => {
  it("lists every board once and gives each board's source a terms row", () => {
    const keys = companyBoards.map((board) =>
      feedKey(boardFeed(board)).toLowerCase()
    );

    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);

    const withoutTerms = companyBoards
      .map((board) => feedRefOf(boardFeed(board)).source)
      .filter(
        (source) =>
          !Object.hasOwn(SourceTerms, source) ||
          SourceTerms[source].kind !== "CompanyBoard"
      );

    expect(duplicates).toStrictEqual([]);
    expect(withoutTerms).toStrictEqual([]);
  });

  it("keeps the registry sorted by company name", () => {
    const names = companyBoards.map((board) => board.name.toLowerCase());

    expect(names).toStrictEqual(names.toSorted());
  });

  it("refreshes every board within six hours at the default feeds per run, with aggregators and one feed that always fails", () => {
    const catalog = feedSpecs(companyBoards).map(feedRefOf);

    expect(
      longestBoardGapMinutes(catalog, DEFAULT_FEEDS_PER_RUN)
    ).toBeLessThanOrEqual(REFRESH_MINUTES);
  });

  it("misses the six hour refresh with 600 boards at the default feeds per run", () => {
    const sixHundred = feedSpecs(
      Array.from({ length: 600 }, (_, index) => ({
        ats: "greenhouse" as const,
        name: `Company ${index}`,
        slug: `company-${index}`,
      }))
    ).map(feedRefOf);

    expect(
      longestBoardGapMinutes(sixHundred, DEFAULT_FEEDS_PER_RUN)
    ).toBeGreaterThan(REFRESH_MINUTES);
  });
});
