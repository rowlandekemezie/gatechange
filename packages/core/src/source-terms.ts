import type { SourceNameValue } from "./job.js";

export interface SourceTermsValue {
  readonly creditUrl: string;
  readonly emailAlerts: boolean;
  readonly jobPostingMarkup: boolean;
  readonly kind: "Aggregator" | "CompanyBoard";
  readonly label: string;
  readonly paidFeatures: boolean;
}

export const SourceTerms: Readonly<Record<SourceNameValue, SourceTermsValue>> =
  {
    Ashby: {
      creditUrl: "https://www.ashbyhq.com",
      emailAlerts: true,
      jobPostingMarkup: true,
      kind: "CompanyBoard",
      label: "Ashby",
      paidFeatures: true,
    },
    Greenhouse: {
      creditUrl: "https://www.greenhouse.com",
      emailAlerts: true,
      jobPostingMarkup: true,
      kind: "CompanyBoard",
      label: "Greenhouse",
      paidFeatures: true,
    },
    HackerNews: {
      creditUrl: "https://news.ycombinator.com",
      emailAlerts: true,
      jobPostingMarkup: true,
      kind: "Aggregator",
      label: "Hacker News",
      paidFeatures: true,
    },
    Himalayas: {
      creditUrl: "https://himalayas.app",
      emailAlerts: false,
      jobPostingMarkup: false,
      kind: "Aggregator",
      label: "Himalayas",
      paidFeatures: false,
    },
    Jobicy: {
      creditUrl: "https://jobicy.com",
      emailAlerts: true,
      jobPostingMarkup: true,
      kind: "Aggregator",
      label: "Jobicy",
      paidFeatures: true,
    },
    Lever: {
      creditUrl: "https://www.lever.co",
      emailAlerts: true,
      jobPostingMarkup: true,
      kind: "CompanyBoard",
      label: "Lever",
      paidFeatures: true,
    },
    RemoteOK: {
      creditUrl: "https://remoteok.com",
      emailAlerts: true,
      jobPostingMarkup: true,
      kind: "Aggregator",
      label: "Remote OK",
      paidFeatures: true,
    },
    Remotive: {
      creditUrl: "https://remotive.com",
      emailAlerts: false,
      jobPostingMarkup: false,
      kind: "Aggregator",
      label: "Remotive",
      paidFeatures: false,
    },
  };
