import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { normalizePosting } from "../src/index.js";
import type { FeedRef, PostingValue } from "../src/index.js";

const himalayas: FeedRef = {
  company: Option.none(),
  key: "himalayas",
  minIntervalMinutes: 60,
  source: "Himalayas",
};

const postingTo = (url: string): PostingValue => ({
  company: "Acme",
  externalId: "1",
  location: "Remote - Canada",
  postedAt: null,
  salary: null,
  title: "Senior Engineering Manager",
  url,
  workplace: "Remote",
});

const linkOf = (url: string) =>
  Option.map(
    normalizePosting(himalayas, postingTo(url), 1_760_000_000_000),
    (job) => job.url
  );

describe("posting apply links", () => {
  it.each([
    "/api/auth/magic-link/verify?token=x",
    "api/auth/magic-link/verify?token=x",
    "//jobs.rowlandekemezie.com/api/auth/magic-link/verify?token=x",
    "https://jobs.rowlandekemezie.com/api/auth/magic-link/verify?token=x&callbackURL=/account",
    "https://JOBS.rowlandekemezie.com./account/confirm?token=x",
    "https://rowlandekemezie.com/jobs/1",
    "https://jobs-pr-12.rowland.workers.dev/api/auth/magic-link/verify?token=x",
    "http://localhost:1337/api/auth/magic-link/verify?token=x",
    "data:text/html,apply",
    "ftp://jobs.acme.example/1",
    "mailto:jobs@acme.example",
  ])("drops a posting whose apply link is %s", (url) => {
    expect(linkOf(url)).toStrictEqual(Option.none());
  });

  it.each([
    "https://boards.greenhouse.io/acme/jobs/42",
    "http://careers.acme.example/jobs/42?ref=himalayas",
    "https://notrowlandekemezie.com/jobs/1",
  ])("keeps a posting that links off site to %s", (url) => {
    expect(linkOf(url)).toStrictEqual(Option.some(url));
  });
});
