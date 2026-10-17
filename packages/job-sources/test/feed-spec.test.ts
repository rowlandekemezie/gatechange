import { describe, expect, it } from "@effect/vitest";
import { Permission, selectDueFeeds, SourceTerms } from "@rat-stack/core";
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

  it("records exactly the permissions each source's published terms state", () => {
    const states = Object.fromEntries(
      Object.entries(SourceTerms).map(
        ([source, { emailAlerts, jobPostingMarkup, paidFeatures }]) => [
          source,
          {
            emailAlerts: emailAlerts._tag,
            jobPostingMarkup: jobPostingMarkup._tag,
            paidFeatures: paidFeatures._tag,
          },
        ]
      )
    );

    expect(states).toStrictEqual({
      Ashby: {
        emailAlerts: "Unstated",
        jobPostingMarkup: "Unstated",
        paidFeatures: "Unstated",
      },
      Greenhouse: {
        emailAlerts: "Unstated",
        jobPostingMarkup: "Unstated",
        paidFeatures: "Unstated",
      },
      HackerNews: {
        emailAlerts: "Forbidden",
        jobPostingMarkup: "Forbidden",
        paidFeatures: "Forbidden",
      },
      Himalayas: {
        emailAlerts: "Unstated",
        jobPostingMarkup: "Forbidden",
        paidFeatures: "Allowed",
      },
      Jobicy: {
        emailAlerts: "Allowed",
        jobPostingMarkup: "Unstated",
        paidFeatures: "Forbidden",
      },
      Lever: {
        emailAlerts: "Unstated",
        jobPostingMarkup: "Unstated",
        paidFeatures: "Unstated",
      },
      RemoteOK: {
        emailAlerts: "Unstated",
        jobPostingMarkup: "Unstated",
        paidFeatures: "Unstated",
      },
      Remotive: {
        emailAlerts: "Forbidden",
        jobPostingMarkup: "Forbidden",
        paidFeatures: "Forbidden",
      },
    });
  });

  it("cites a quote and an https terms URL for every stated permission", () => {
    const citations = Object.values(SourceTerms)
      .flatMap(({ emailAlerts, jobPostingMarkup, paidFeatures }) => [
        emailAlerts,
        jobPostingMarkup,
        paidFeatures,
      ])
      .flatMap((permission): readonly { quote: string; url: string }[] =>
        Permission.$match(permission, {
          Allowed: (citation) => [citation],
          Forbidden: (citation) => [citation],
          Unstated: () => [],
        })
      );

    expect(citations.length).toBeGreaterThan(0);

    for (const { quote, url } of citations) {
      expect(quote.trim()).not.toBe("");
      expect(new URL(url).protocol).toBe("https:");
    }
  });

  it("keeps Hacker News and Jobicy out of paid features", () => {
    expect(SourceTerms.HackerNews.paidFeatures._tag).toBe("Forbidden");
    expect(SourceTerms.Jobicy.paidFeatures._tag).toBe("Forbidden");
  });
});
