import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { listingsFromPostings } from "../src/index.js";
import type { FeedRef, PostingValue } from "../src/index.js";

const feed: FeedRef = {
  company: Option.some("Acme"),
  coverage: "Complete",
  key: "greenhouse:acme",
  minIntervalMinutes: 1,
  source: "Greenhouse",
};

const posting = (company: string): PostingValue => ({
  company,
  externalId: "same-id",
  location: "Remote - Canada",
  postedAt: null,
  salary: null,
  title: "Engineering Manager",
  url: "/invalid-apply-link",
  workplace: "Remote",
});

describe("unlinked duplicate provenance", () => {
  it("does not promote an untrusted first occurrence with a catalog-derived duplicate", () => {
    const listings = listingsFromPostings(
      feed,
      [posting("Acme"), posting("")],
      1_760_000_000_000
    );

    expect(listings.jobs).toHaveLength(0);
    expect(listings.unlinked).toHaveLength(1);
    expect(listings.historySightings).toHaveLength(0);
  });

  it("keeps a catalog-derived first occurrence and its warning count", () => {
    const listings = listingsFromPostings(
      feed,
      [posting(""), posting("Another Company")],
      1_760_000_000_000
    );

    expect(listings.jobs).toHaveLength(0);
    expect(listings.unlinked).toHaveLength(1);
    expect(
      listings.historySightings.map((listing) => listing.company)
    ).toStrictEqual(["Acme"]);
  });
});
