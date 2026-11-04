import { describe, expect, it } from "@effect/vitest";

import {
  AccountId,
  alertsAllowed,
  DAY_MILLIS,
  digestFor,
  digestSourceLabels,
  Permission,
  SavedSearchId,
  SourceTerms,
} from "../src/index.js";
import type { JobValue, SavedSearchValue } from "../src/index.js";

const search: SavedSearchValue = {
  createdAt: 0,
  filters: {
    regions: ["RemoteCanada"],
    roles: ["EngineeringManager"],
    search: "",
  },
  frequency: "Weekly",
  id: SavedSearchId.make("s1"),
  owner: AccountId.make("user_ada"),
};

const recipient = {
  account: AccountId.make("user_ada"),
  email: "ada@example.com",
  searches: [search],
  since: 0,
};

const role = (source: JobValue["source"]): JobValue => ({
  arrangement: "Remote",
  company: "Acme",
  feed: `${source}:all`,
  firstSeenAt: 10,
  id: `${source}:1`,
  lastSeenAt: 10,
  location: "Remote - Canada",
  postedAt: 10,
  region: "RemoteCanada",
  relevance: 50,
  role: "EngineeringManager",
  salary: null,
  source,
  title: "Engineering Manager",
  url: "https://jobs.example/1",
});

const citation = { quote: "Alerts are fine.", url: "https://example.com" };

describe("digest freshness", () => {
  it("leaves out a long-open company board role even where its terms allow alerts", () => {
    const firstSeenAt = 200 * DAY_MILLIS;

    const terms = {
      ...SourceTerms,
      Greenhouse: {
        ...SourceTerms.Greenhouse,
        emailAlerts: Permission.Allowed({
          quote: "Alerts are fine.",
          url: "https://example.com",
        }),
      },
    };

    const longOpen = {
      ...role("Greenhouse"),
      firstSeenAt,
      postedAt: firstSeenAt - 31 * DAY_MILLIS,
    };

    const justPosted = { ...longOpen, id: "fresh", postedAt: firstSeenAt };

    expect(digestFor(recipient, 0, [longOpen], terms).total).toBe(0);
    expect(digestFor(recipient, 0, [justPosted], terms).total).toBe(1);
  });
});

describe("digest eligibility follows SourceTerms", () => {
  it("excludes a company board whose alert terms are Unstated", () => {
    expect(alertsAllowed("Greenhouse")).toBe(false);
    expect(digestFor(recipient, 0, [role("Greenhouse")]).total).toBe(0);
  });

  it("includes a source whose alert terms are Allowed", () => {
    expect(digestFor(recipient, 0, [role("Jobicy")]).total).toBe(1);
    expect(digestSourceLabels()).toEqual(["Jobicy"]);
  });

  it("includes a source once its terms flip to Allowed", () => {
    const flipped = {
      ...SourceTerms,
      Greenhouse: {
        ...SourceTerms.Greenhouse,
        emailAlerts: Permission.Allowed(citation),
      },
    };

    expect(digestFor(recipient, 0, [role("Greenhouse")], flipped).total).toBe(
      1
    );
    expect(digestSourceLabels(flipped)).toEqual(["Greenhouse", "Jobicy"]);
  });

  it("drops a source once its terms flip to Forbidden", () => {
    const flipped = {
      ...SourceTerms,
      Jobicy: {
        ...SourceTerms.Jobicy,
        emailAlerts: Permission.Forbidden(citation),
      },
    };

    expect(digestFor(recipient, 0, [role("Jobicy")], flipped).total).toBe(0);
  });
});
