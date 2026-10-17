import { describe, expect, it } from "@effect/vitest";
import { selectDueFeeds, SourceTerms } from "@rat-stack/core";
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

const CRON_MINUTES = 20;

const REFRESH_MINUTES = 6 * 60;

const SIMULATED_MINUTES = 24 * 60;

const WORKERS_FREE_FEEDS_PER_RUN = 15;

const longestBoardGapMinutes = (
  catalog: readonly FeedRef[],
  feedsPerRun: number
) => {
  const states = new Map<string, FeedStateValue>();
  const lastFetched = new Map<string, number>();
  let longest = 0;

  for (let minute = 0; minute <= SIMULATED_MINUTES; minute += CRON_MINUTES) {
    const due = selectDueFeeds(
      catalog,
      [...states.values()],
      minute * MINUTE,
      feedsPerRun
    );

    for (const feed of due) {
      states.set(feed.key, {
        consecutiveFailures: 0,
        key: feed.key,
        lastAttemptAt: minute * MINUTE,
        lastError: null,
        lastSuccessAt: minute * MINUTE,
      });
      lastFetched.set(feed.key, minute);
    }

    for (const feed of catalog) {
      if (Option.isSome(feed.company)) {
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

  it("refreshes every board within six hours on the Workers Free feeds-per-run budget", () => {
    const catalog = feedSpecs(companyBoards).map(feedRefOf);

    expect(
      longestBoardGapMinutes(catalog, WORKERS_FREE_FEEDS_PER_RUN)
    ).toBeLessThanOrEqual(REFRESH_MINUTES);
  });

  it("misses the six hour refresh with 400 boards on the Workers Free budget", () => {
    const fourHundred = feedSpecs(
      Array.from({ length: 400 }, (_, index) => ({
        ats: "greenhouse" as const,
        name: `Company ${index}`,
        slug: `company-${index}`,
      }))
    ).map(feedRefOf);

    expect(
      longestBoardGapMinutes(fourHundred, WORKERS_FREE_FEEDS_PER_RUN)
    ).toBeGreaterThan(REFRESH_MINUTES);
  });
});
