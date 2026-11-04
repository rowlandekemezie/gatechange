import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { listingsFromPostings } from "../src/index.js";
import type { FeedRef, PostingValue } from "../src/index.js";

const SEEN_AT = 1_760_000_000_000;

const leverFeed: FeedRef = {
  company: Option.some("Acme"),
  coverage: "Complete",
  key: "lever:acme",
  minIntervalMinutes: 1,
  source: "Lever",
};

const posting = (overrides: Partial<PostingValue> = {}): PostingValue => ({
  company: "",
  externalId: "1",
  location: "Remote - Canada",
  postedAt: null,
  salary: null,
  title: "Senior Engineering Manager",
  url: "https://jobs.example/1",
  workplace: "Remote",
  ...overrides,
});

describe("board facts at ingest", () => {
  it("takes salary, remote policy and seniority from a company board's structured fields", () => {
    const { boardFacts } = listingsFromPostings(
      leverFeed,
      [
        posting({
          salaryBand: { currency: "CAD", max: 240_000, min: 200_000 },
        }),
        posting({ externalId: "2", location: "Remote", workplace: "Remote" }),
        posting({
          externalId: "3",
          location: "Toronto",
          title: "Head of Engineering",
          workplace: "Hybrid",
        }),
      ],
      SEEN_AT
    );

    expect(boardFacts).toStrictEqual([
      {
        board: "Lever",
        facts: {
          remotePolicy: "RemoteInRegion",
          salary: { currency: "CAD", max: 240_000, min: 200_000 },
          seniority: "SeniorManager",
        },
        id: "lever:acme:1",
      },
      {
        board: "Lever",
        facts: {
          remotePolicy: "Remote",
          salary: null,
          seniority: "SeniorManager",
        },
        id: "lever:acme:2",
      },
      {
        board: "Lever",
        facts: { remotePolicy: "Hybrid", salary: null, seniority: null },
        id: "lever:acme:3",
      },
    ]);
  });

  it("records nothing when the board states none of the facts", () => {
    const { boardFacts, jobs } = listingsFromPostings(
      leverFeed,
      [posting({ title: "Head of Engineering", workplace: "Unspecified" })],
      SEEN_AT
    );

    expect(jobs).toHaveLength(1);
    expect(boardFacts).toStrictEqual([]);
  });

  it("leaves aggregator listings to their own terms", () => {
    const { boardFacts, jobs } = listingsFromPostings(
      { ...leverFeed, key: "remoteok", source: "RemoteOK" },
      [
        posting({
          salaryBand: { currency: "USD", max: 200_000, min: 180_000 },
        }),
      ],
      SEEN_AT
    );

    expect(jobs).toHaveLength(1);
    expect(boardFacts).toStrictEqual([]);
  });
});
