import { describe, expect, it } from "@effect/vitest";
import { selectDueFeeds, SourceTerms } from "@rat-stack/core";
import type { FeedRef, FeedStateValue, SourceNameValue } from "@rat-stack/core";

import { companyBoards, feedRefOf, feedSpecs } from "../src/index.js";

const MINUTE = 60_000;

const CRON_MINUTES = 20;

const DAY_MINUTES = 24 * 60;

const catalog: readonly FeedRef[] = feedSpecs(companyBoards).map(feedRefOf);

const attemptsInOneDay = (source: SourceNameValue) => {
  const states = new Map<string, FeedStateValue>();
  let attempts = 0;

  for (let minute = 0; minute < DAY_MINUTES; minute += CRON_MINUTES) {
    const now = minute * MINUTE;

    const due = selectDueFeeds(
      catalog,
      [...states.values()],
      now,
      catalog.length
    );

    for (const feed of due) {
      states.set(feed.key, {
        consecutiveFailures: 0,
        key: feed.key,
        lastAttemptAt: now,
        lastError: null,
        lastSuccessAt: now,
      });
      attempts += feed.source === source ? 1 : 0;
    }
  }

  return attempts;
};

describe("source request limits", () => {
  it("every Remotive search together asks Remotive at most four times a day", () => {
    expect(
      catalog.filter((feed) => feed.source === "Remotive").length
    ).toBeGreaterThan(0);
    expect(attemptsInOneDay("Remotive")).toBeLessThanOrEqual(4);
  });

  it("no Jobicy feed polls more than once an hour", () => {
    const jobicy = catalog.filter((feed) => feed.source === "Jobicy");

    expect(jobicy.length).toBeGreaterThan(0);
    expect(jobicy.every((feed) => feed.minIntervalMinutes >= 60)).toBe(true);
  });
});

describe("source terms", () => {
  it("every source in the catalog has a terms row", () => {
    const missing = catalog.filter(
      (feed) => !Object.hasOwn(SourceTerms, feed.source)
    );

    expect(missing).toStrictEqual([]);
  });

  it("Remotive and Himalayas stay out of alerts, paid features, and JobPosting markup", () => {
    for (const source of ["Remotive", "Himalayas"] as const) {
      expect(SourceTerms[source]).toMatchObject({
        emailAlerts: false,
        jobPostingMarkup: false,
        paidFeatures: false,
      });
    }
  });
});
