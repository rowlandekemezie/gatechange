import { SITE_WORKERS_SUBDOMAIN } from "@rat-stack/core";
import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { selfHostOrigin, selfHostProblems } from "../src/self-host.js";

const ready = {
  ALCHEMY_PROFILE: "mine",
  BETTER_AUTH_SECRET: "s".repeat(32),
  WORKERS_SUBDOMAIN: SITE_WORKERS_SUBDOMAIN,
};

describe("selfHostProblems", () => {
  it("accepts a fresh stage with credentials, a secret and the site's own subdomain", () => {
    expect(selfHostProblems("self", ready)).toStrictEqual([]);
    expect(
      selfHostProblems("self", {
        ...ready,
        ALCHEMY_PROFILE: undefined,
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
      })
    ).toStrictEqual([]);
  });

  it.each(["prod", "preview", "pr-12", "Self", "my_stage"])(
    "refuses stage %s, which would touch the owner's domain, previews or an invalid Worker name",
    (stage) => {
      expect(selfHostProblems(stage, ready)).toHaveLength(1);
    }
  );

  it("names every missing input at once instead of failing mid-deploy", () => {
    const problems = selfHostProblems("self", {
      BETTER_AUTH_SECRET: "short",
    });

    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/ALCHEMY_PROFILE/u);
    expect(problems.join("\n")).toMatch(/BETTER_AUTH_SECRET/u);
    expect(problems.join("\n")).toMatch(/WORKERS_SUBDOMAIN/u);
  });

  it("asks for the site subdomain edit when the account's subdomain differs", () => {
    expect(
      selfHostProblems("self", { ...ready, WORKERS_SUBDOMAIN: "someone-else" })
    ).toStrictEqual([
      'Set SITE_WORKERS_SUBDOMAIN in packages/core/src/site.ts to "someone-else". The site trusts its own links and sign-in host only on that subdomain.',
    ]);
  });

  it("reports the workers.dev URL the stage will serve", () => {
    expect(selfHostOrigin("self", ready)).toStrictEqual(
      Option.some(`https://jobs-self.${SITE_WORKERS_SUBDOMAIN}.workers.dev`)
    );
  });
});
