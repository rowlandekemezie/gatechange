import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import {
  canonicalSiteUrlOf,
  isPullRequestStage,
  offSiteHref,
  offSiteHrefOn,
  OWNER_WORKERS_SUBDOMAIN,
  publicOriginOf,
  SITE_ORIGIN,
  siteHostsOf,
  siteWorkersSubdomainOf,
  WorkersSubdomain,
} from "../src/index.js";

const LOCAL = ["localhost:*"];

describe("siteHostsOf", () => {
  it.each([Option.none(), Option.some("acct")])(
    "trusts exactly https://gatechange.dev on prod, whatever else is set (%o)",
    (workersSubdomain) => {
      expect(
        siteHostsOf("prod", { localHosts: LOCAL, workersSubdomain })
      ).toStrictEqual({
        allowedHosts: ["gatechange.dev"],
        fallbackOrigin: Option.some("https://gatechange.dev"),
      });
    }
  );

  it.each(["verify-j7r3", "dev", "Prod"])(
    "trusts only %s's own Worker on this account's workers.dev and local hosts, never prod",
    (stage) => {
      expect(
        siteHostsOf(stage, {
          localHosts: LOCAL,
          workersSubdomain: Option.some("acct"),
        })
      ).toStrictEqual({
        allowedHosts: [
          `jobs-${stage.toLowerCase()}.acct.workers.dev`,
          ...LOCAL,
        ],
        fallbackOrigin: Option.none(),
      });
    }
  );

  it("trusts no workers.dev host on a preview stage when the account subdomain is unknown", () => {
    expect(
      siteHostsOf("verify-x", {
        localHosts: [],
        workersSubdomain: Option.none(),
      })
    ).toStrictEqual({ allowedHosts: [], fallbackOrigin: Option.none() });
  });
});

describe("WorkersSubdomain", () => {
  it.each(["*", "acct.evil", "", "Acct", "-acct", "acct-"])(
    "refuses %o, which would widen the trusted host",
    (value) => {
      expect(Schema.is(WorkersSubdomain)(value)).toBe(false);
    }
  );

  it("accepts an account subdomain", () => {
    expect(Schema.is(WorkersSubdomain)("rowland-ekemezie")).toBe(true);
  });
});

describe("pull request origins", () => {
  it.each(["pr-1", "pr-123"])(
    "uses the native preview hostname for %s",
    (stage) => {
      const origin = `https://${stage}-jobs-preview.acct.workers.dev`;
      expect(isPullRequestStage(stage)).toBe(true);
      expect(publicOriginOf(stage, Option.some("acct"))).toEqual(
        Option.some(origin)
      );
      expect(
        siteHostsOf(stage, {
          localHosts: [],
          workersSubdomain: Option.some("acct"),
        }).allowedHosts
      ).toEqual([new URL(origin).host]);
    }
  );

  it.each(["pr-0", "pr-01", "pr-1/foo", "PR-1", "preview", "prod"])(
    "does not treat %s as a PR",
    (stage) => {
      expect(isPullRequestStage(stage)).toBe(false);
    }
  );
});

describe("canonicalSiteUrlOf", () => {
  it.each([
    [
      "https://jobs.rowlandekemezie.com/jobs/greenhouse%3Aacme%2F1?q=staff&age=30",
      "https://gatechange.dev/jobs/greenhouse%3Aacme%2F1?q=staff&age=30",
    ],
    [
      "https://JOBS.rowlandekemezie.com/api/auth/magic-link/verify?token=a%2Bb",
      "https://gatechange.dev/api/auth/magic-link/verify?token=a%2Bb",
    ],
    ["https://jobs.rowlandekemezie.com", "https://gatechange.dev/"],
    ["https://jobs.rowlandekemezie.com./about", "https://gatechange.dev/about"],
    ["http://www.gatechange.dev/pricing?", "https://gatechange.dev/pricing"],
  ])("moves %s to %s on gatechange.dev", (from, to) => {
    expect(
      Option.map(canonicalSiteUrlOf(new URL(from)), (url) => url.href)
    ).toStrictEqual(Option.some(to));
  });

  it.each([
    "https://jobs.rowlandekemezie.com//evil.com/x?a=1",
    "https://jobs.rowlandekemezie.com/\\evil.com",
    "https://jobs.rowlandekemezie.com/%2F%2Fevil.com",
    "https://jobs.rowlandekemezie.com///evil.com",
    "https://jobs.rowlandekemezie.com/\\\\evil.com",
    "https://www.gatechange.dev//evil.com",
  ])("keeps %s on gatechange.dev", (from) => {
    const moved = Option.getOrThrow(canonicalSiteUrlOf(new URL(from)));

    expect(new URL(moved.href).origin).toBe(SITE_ORIGIN);
  });

  it.each([
    "https://gatechange.dev/jobs/1?q=x",
    "https://jobs-pr-12.rowland-ekemezie.workers.dev/",
    "https://evil.jobs.rowlandekemezie.com/",
    "https://rowlandekemezie.com/",
    "http://localhost:1337/",
  ])("serves %s where it is", (from) => {
    expect(canonicalSiteUrlOf(new URL(from))).toStrictEqual(Option.none());
  });
});

describe("own-host links", () => {
  it("drops a listing link to the owner's own Worker when nothing is configured", () => {
    expect(
      offSiteHref(
        `https://jobs-preview.${OWNER_WORKERS_SUBDOMAIN}.workers.dev/api/auth/magic-link/verify?token=synthetic`
      )
    ).toStrictEqual(Option.none());
    expect(offSiteHref("https://gatechange.dev/jobs/1")).toStrictEqual(
      Option.none()
    );
  });

  it("drops a listing link to a self-host's own Worker on its configured subdomain", () => {
    const selfHosted = offSiteHrefOn(siteWorkersSubdomainOf("alice"));

    expect(
      selfHosted(
        "https://jobs-self.alice.workers.dev/api/auth/magic-link/verify?token=synthetic"
      )
    ).toStrictEqual(Option.none());
    expect(selfHosted("https://alice.workers.dev/")).toStrictEqual(
      Option.none()
    );
    expect(selfHosted("https://someone.workers.dev/jobs/1")).toStrictEqual(
      Option.some("https://someone.workers.dev/jobs/1")
    );
  });

  it.each([undefined, ""])(
    "falls back to the owner's subdomain when WORKERS_SUBDOMAIN is %o at build",
    (configured) => {
      expect(siteWorkersSubdomainOf(configured)).toBe(OWNER_WORKERS_SUBDOMAIN);
    }
  );
});
