import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import {
  isPullRequestStage,
  publicOriginOf,
  siteHostsOf,
  WorkersSubdomain,
} from "../src/index.js";

const LOCAL = ["localhost:*"];

describe("siteHostsOf", () => {
  it.each([Option.none(), Option.some("acct")])(
    "trusts exactly https://jobs.rowlandekemezie.com on prod, whatever else is set (%o)",
    (workersSubdomain) => {
      expect(
        siteHostsOf("prod", { localHosts: LOCAL, workersSubdomain })
      ).toStrictEqual({
        allowedHosts: ["jobs.rowlandekemezie.com"],
        fallbackOrigin: Option.some("https://jobs.rowlandekemezie.com"),
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
