import { describe, expect, it } from "@effect/vitest";

import { Permission, SourceTerms } from "../src/index.js";

describe("source terms", () => {
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
        paidFeatures: "Unstated",
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
});
