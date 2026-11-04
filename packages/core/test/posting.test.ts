import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { normalizePosting } from "../src/index.js";
import type { FeedRef, PostingValue } from "../src/index.js";

const himalayas: FeedRef = {
  company: Option.none(),
  coverage: "Window",
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
  Option.flatMap(
    normalizePosting(himalayas, postingTo(url), 1_760_000_000_000),
    (listing) => listing.url
  );

describe("posting apply links", () => {
  it.each([
    "/api/auth/magic-link/verify?token=x",
    "api/auth/magic-link/verify?token=x",
    "//jobs.rowlandekemezie.com/api/auth/magic-link/verify?token=x",
    "https://jobs.rowlandekemezie.com/api/auth/magic-link/verify?token=x&callbackURL=/account",
    "https://JOBS.rowlandekemezie.com./account/confirm?token=x",
    "https://rowlandekemezie.com/jobs/1",
    "https://jobs-pr-12.rowland-ekemezie.workers.dev/api/auth/magic-link/verify?token=x",
    "https://rowland-ekemezie.workers.dev/account/confirm?token=x",
    "http://localhost:1337/api/auth/magic-link/verify?token=x",
    "http://127.0.0.1:1337/api/auth/magic-link/verify?token=x",
    "http://127.1:1337/account/confirm?token=x",
    "http://[::1]:1337/api/auth/magic-link/verify?token=x",
    "https://jobs.rowlandekemezie%2Ecom/api/auth/magic-link/verify?token=x",
    "https://evil.example@jobs.rowlandekemezie.com/account/confirm?token=x",
    "data:text/html,apply",
    "ftp://jobs.acme.example/1",
    "mailto:jobs@acme.example",
    "https:/api/auth/magic-link/verify?token=x&callbackURL=/account",
    "HTTPS:/api/auth/magic-link/verify?token=x",
    "https:\\api/auth/magic-link/verify?token=x",
    " https:/api/auth/magic-link/verify?token=x",
    "https:\t/api/auth/magic-link/verify?token=x",
    "https:/account/confirm?token=x",
    "https:api/auth/magic-link/verify?token=x",
    "http:/api/auth/magic-link/verify?token=x",
    "https://jobs.rowlandekemezie.com../account/confirm?token=x",
    "https://127.0.0.2/account/confirm?token=x",
    "https://0.0.0.0/account/confirm?token=x",
    "http://[::ffff:127.0.0.1]:1337/account/confirm?token=x",
    "http://[::127.0.0.1]:1337/account/confirm?token=x",
    "http://[::]:1337/account/confirm?token=x",
    "http://[::ffff:0:0]:1337/account/confirm?token=x",
    "https://[2001:db8::1]/jobs/1",
    "https://203.0.113.9/jobs/1",
    "https://jobs.rowlandekemezie.com&sol;api/auth/magic-link/verify?token=x",
    "https://careers_acme.example/jobs/1",
  ])("drops a posting whose apply link is %s", (url) => {
    expect(linkOf(url)).toStrictEqual(Option.none());
  });

  it.each([
    "https://boards.greenhouse.io/acme/jobs/42",
    "http://careers.acme.example/jobs/42?ref=himalayas",
    "https://notrowlandekemezie.com/jobs/1",
    "https://xn--bcher-kva.example/jobs/1",
    "https://someone.workers.dev/jobs/1",
    "https://jobs-pr-12.rowland.workers.dev/jobs/1",
  ])("keeps a posting that links off site to %s", (url) => {
    expect(linkOf(url)).toStrictEqual(Option.some(url));
  });

  it("stores the absolute form of the link it checked", () => {
    expect(linkOf(" HTTPS://Boards.Greenhouse.io/acme/jobs/42")).toStrictEqual(
      Option.some("https://boards.greenhouse.io/acme/jobs/42")
    );
  });
});
