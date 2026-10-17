import { Data } from "effect";

import type { SourceNameValue } from "./job.js";

interface Citation {
  readonly quote: string;
  readonly url: string;
}

export type PermissionValue = Data.TaggedEnum<{
  Allowed: Citation;
  Forbidden: Citation;
  Unstated: Record<never, never>;
}>;

export const Permission = Data.taggedEnum<PermissionValue>();

export interface SourceTermsValue {
  readonly creditUrl: string;
  readonly emailAlerts: PermissionValue;
  readonly jobPostingMarkup: PermissionValue;
  readonly kind: "Aggregator" | "CompanyBoard";
  readonly label: string;
  readonly paidFeatures: PermissionValue;
}

const unstated = Permission.Unstated();

const YC_TERMS = "https://www.ycombinator.com/legal";

const ycSiteContent = Permission.Forbidden({
  quote:
    "Except as expressly authorized by Y Combinator, you agree not to modify, copy, frame, scrape, rent, lease, loan, sell, distribute or create derivative works based on the Site or the Site Content, in whole or in part",
  url: YC_TERMS,
});

const REMOTIVE_TERMS = "https://github.com/remotive-com/remote-jobs-api";

const remotiveSignups = Permission.Forbidden({
  quote:
    "Displaying our jobs in order to collect signups/email addresses to show a listing constitutes a breach of our terms of services.",
  url: REMOTIVE_TERMS,
});

export const SourceTerms: Readonly<Record<SourceNameValue, SourceTermsValue>> =
  {
    Ashby: {
      creditUrl: "https://www.ashbyhq.com",
      emailAlerts: unstated,
      jobPostingMarkup: unstated,
      kind: "CompanyBoard",
      label: "Ashby",
      paidFeatures: unstated,
    },
    Greenhouse: {
      creditUrl: "https://www.greenhouse.com",
      emailAlerts: unstated,
      jobPostingMarkup: unstated,
      kind: "CompanyBoard",
      label: "Greenhouse",
      paidFeatures: unstated,
    },
    HackerNews: {
      creditUrl: "https://news.ycombinator.com",
      emailAlerts: ycSiteContent,
      jobPostingMarkup: ycSiteContent,
      kind: "Aggregator",
      label: "Hacker News",
      paidFeatures: Permission.Forbidden({
        quote:
          "Unless otherwise expressly authorized herein or in the Site, you agree not to display, distribute, license, perform, publish, reproduce, duplicate, copy, create derivative works from, modify, sell, resell, exploit, transfer or upload for any commercial purposes, any portion of the Site, use of the Site, or access to the Site.",
        url: YC_TERMS,
      }),
    },
    Himalayas: {
      creditUrl: "https://himalayas.app",
      emailAlerts: unstated,
      jobPostingMarkup: Permission.Forbidden({
        quote:
          "Do not redistribute jobs to other job boards or aggregators, including Google Jobs or LinkedIn Jobs.",
        url: "https://himalayas.app/docs/remote-jobs-api",
      }),
      kind: "Aggregator",
      label: "Himalayas",
      paidFeatures: Permission.Allowed({
        quote:
          "You may use the API in personal and commercial integrations on these conditions:",
        url: "https://himalayas.app/terms",
      }),
    },
    Jobicy: {
      creditUrl: "https://jobicy.com",
      emailAlerts: Permission.Allowed({
        quote:
          "Most integrations, including job boards, newsletters, career tools, AI assistants, and internal applications, can use the public API without a separate agreement.",
        url: "https://jobicy.com/jobs-rss-feed",
      }),
      jobPostingMarkup: unstated,
      kind: "Aggregator",
      label: "Jobicy",
      paidFeatures: Permission.Forbidden({
        quote:
          "resold or redistributed without the prior written consent of Jobicy.com",
        url: "https://jobicy.com/terms-and-conditions",
      }),
    },
    Lever: {
      creditUrl: "https://www.lever.co",
      emailAlerts: unstated,
      jobPostingMarkup: unstated,
      kind: "CompanyBoard",
      label: "Lever",
      paidFeatures: unstated,
    },
    RemoteOK: {
      creditUrl: "https://remoteok.com",
      emailAlerts: unstated,
      jobPostingMarkup: unstated,
      kind: "Aggregator",
      label: "Remote OK",
      paidFeatures: unstated,
    },
    Remotive: {
      creditUrl: "https://remotive.com",
      emailAlerts: remotiveSignups,
      jobPostingMarkup: Permission.Forbidden({
        quote:
          "Please do not submit Remotive jobs to third Party websites, including but not limited to: Jooble, Neuvoo, Google Jobs, LinkedIn Jobs.",
        url: REMOTIVE_TERMS,
      }),
      kind: "Aggregator",
      label: "Remotive",
      paidFeatures: remotiveSignups,
    },
  };
