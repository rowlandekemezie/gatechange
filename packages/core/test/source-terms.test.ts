import { describe, expect, it } from "@effect/vitest";

import { Permission, SourceTerms } from "../src/index.js";

describe("source terms", () => {
  it("records exactly the permissions each source's published terms state", () => {
    const states = Object.fromEntries(
      Object.entries(SourceTerms).map(
        ([
          source,
          { agentAccess, emailAlerts, jobPostingMarkup, paidFeatures },
        ]) => [
          source,
          {
            agentAccess: agentAccess._tag,
            emailAlerts: emailAlerts._tag,
            jobPostingMarkup: jobPostingMarkup._tag,
            paidFeatures: paidFeatures._tag,
          },
        ]
      )
    );

    expect(states).toStrictEqual({
      Ashby: {
        agentAccess: "Unstated",
        emailAlerts: "Unstated",
        jobPostingMarkup: "Unstated",
        paidFeatures: "Unstated",
      },
      Greenhouse: {
        agentAccess: "Unstated",
        emailAlerts: "Unstated",
        jobPostingMarkup: "Unstated",
        paidFeatures: "Unstated",
      },
      HackerNews: {
        agentAccess: "Forbidden",
        emailAlerts: "Forbidden",
        jobPostingMarkup: "Forbidden",
        paidFeatures: "Forbidden",
      },
      Himalayas: {
        agentAccess: "Forbidden",
        emailAlerts: "Unstated",
        jobPostingMarkup: "Forbidden",
        paidFeatures: "Allowed",
      },
      Jobicy: {
        agentAccess: "Allowed",
        emailAlerts: "Allowed",
        jobPostingMarkup: "Unstated",
        paidFeatures: "Unstated",
      },
      Lever: {
        agentAccess: "Unstated",
        emailAlerts: "Unstated",
        jobPostingMarkup: "Unstated",
        paidFeatures: "Unstated",
      },
      RemoteOK: {
        agentAccess: "Unstated",
        emailAlerts: "Unstated",
        jobPostingMarkup: "Unstated",
        paidFeatures: "Unstated",
      },
      Remotive: {
        agentAccess: "Forbidden",
        emailAlerts: "Forbidden",
        jobPostingMarkup: "Forbidden",
        paidFeatures: "Forbidden",
      },
      SmartRecruiters: {
        agentAccess: "Unstated",
        emailAlerts: "Unstated",
        jobPostingMarkup: "Unstated",
        paidFeatures: "Unstated",
      },
      Workable: {
        agentAccess: "Unstated",
        emailAlerts: "Unstated",
        jobPostingMarkup: "Unstated",
        paidFeatures: "Unstated",
      },
    });
  });

  it("cites a quote and an https terms URL for every stated permission", () => {
    const citations = Object.values(SourceTerms)
      .flatMap(
        ({ agentAccess, emailAlerts, jobPostingMarkup, paidFeatures }) => [
          agentAccess,
          emailAlerts,
          jobPostingMarkup,
          paidFeatures,
        ]
      )
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
