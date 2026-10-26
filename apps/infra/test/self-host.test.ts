import { Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  confirmationOf,
  CredentialSource,
  credentialSourceOf,
  profileAccountIdIn,
  selfHostOrigin,
  selfHostProblems,
  targetSummary,
} from "../src/self-host.js";

const ready = {
  ALCHEMY_PROFILE: "mine",
  BETTER_AUTH_SECRET: "s".repeat(32),
  WORKERS_SUBDOMAIN: "alice",
};

const profiles = (accounts: Record<string, string>) => (profile: string) =>
  Option.fromUndefinedOr(accounts[profile]);

const mine = profiles({ mine: "mine-account" });

const problemsOf = (stage: string, env: Record<string, string | undefined>) =>
  selfHostProblems(stage, env, credentialSourceOf(env, mine));

describe("selfHostProblems", () => {
  it("accepts a fresh stage with credentials, a secret and a workers.dev subdomain", () => {
    expect(problemsOf("self", ready)).toStrictEqual([]);
    expect(
      problemsOf("self", {
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
      expect(problemsOf(stage, ready)).toHaveLength(1);
    }
  );

  it("names every missing input at once instead of failing mid-deploy", () => {
    const problems = problemsOf("self", { BETTER_AUTH_SECRET: "short" });

    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/ALCHEMY_PROFILE/u);
    expect(problems.join("\n")).toMatch(/BETTER_AUTH_SECRET/u);
    expect(problems.join("\n")).toMatch(/WORKERS_SUBDOMAIN/u);
  });

  it.each(["", "  ", "Alice", "alice.evil"])(
    "refuses WORKERS_SUBDOMAIN %o, which the build would trust as the site's own host",
    (subdomain) => {
      expect(
        problemsOf("self", { ...ready, WORKERS_SUBDOMAIN: subdomain })
      ).toHaveLength(1);
    }
  );

  it("refuses a profile that holds no Cloudflare account", () => {
    expect(
      problemsOf("self", { ...ready, ALCHEMY_PROFILE: "empty" })
    ).toStrictEqual([
      'Alchemy profile "empty" has no Cloudflare account. Run pnpm alchemy profile edit --profile empty --add Cloudflare.',
    ]);
  });

  it("reports the workers.dev URL the stage will serve", () => {
    expect(selfHostOrigin("self", ready)).toStrictEqual(
      Option.some("https://jobs-self.alice.workers.dev")
    );
  });
});

describe("credentialSourceOf", () => {
  it("lets complete Cloudflare environment credentials win over ALCHEMY_PROFILE, as Alchemy does", () => {
    expect(
      credentialSourceOf(
        {
          ALCHEMY_PROFILE: "mine",
          CLOUDFLARE_ACCOUNT_ID: "shell-account",
          CLOUDFLARE_API_TOKEN: "token",
        },
        mine
      )
    ).toStrictEqual(
      CredentialSource.Environment({ accountId: "shell-account" })
    );
  });

  it("uses the profile when the environment credentials are incomplete", () => {
    expect(
      credentialSourceOf(
        { ALCHEMY_PROFILE: "mine", CLOUDFLARE_ACCOUNT_ID: "shell-account" },
        mine
      )
    ).toStrictEqual(
      CredentialSource.Profile({
        accountId: Option.some("mine-account"),
        profile: "mine",
      })
    );
  });

  it("never falls back to Alchemy's default profile", () => {
    expect(
      credentialSourceOf({}, profiles({ default: "owner-account" }))
    ).toStrictEqual(CredentialSource.None());
  });
});

describe("profileAccountIdIn", () => {
  const files = new Map([
    ["/home/.alchemy/profiles/broken/cloudflare.json", "{"],
    [
      "/home/.alchemy/profiles/mine/cloudflare.json",
      JSON.stringify({
        format: 1,
        metadata: {},
        provider: "Cloudflare",
        values: { accountId: "abc123", apiToken: "secret", method: "stored" },
      }),
    ],
  ]);

  const accountOf = profileAccountIdIn("/home/.alchemy", (file) =>
    Option.fromUndefinedOr(files.get(file))
  );

  it("reads the account id of the named profile", () => {
    expect(accountOf("mine")).toStrictEqual(Option.some("abc123"));
  });

  it.each(["missing", "broken", "../mine", ""])(
    "finds no account for profile %o",
    (profile) => {
      expect(accountOf(profile)).toStrictEqual(Option.none());
    }
  );
});

describe("targetSummary", () => {
  it("names the credential source and account but never a token", () => {
    const env = {
      ...ready,
      CLOUDFLARE_ACCOUNT_ID: "shell-account",
      CLOUDFLARE_API_TOKEN: "do-not-print",
    };

    const summary = targetSummary(
      "deploy",
      "self",
      env,
      credentialSourceOf(env, mine)
    );

    expect(summary).toContain("Cloudflare account: shell-account");
    expect(summary).toContain('override ALCHEMY_PROFILE "mine"');
    expect(summary).toContain("https://jobs-self.alice.workers.dev");
    expect(summary).not.toContain("do-not-print");
  });
});

describe("confirmationOf", () => {
  it("plans without asking", () => {
    expect(confirmationOf("plan", { interactive: false, yes: false })).toBe(
      "proceed"
    );
  });

  it.each(["deploy", "destroy"] as const)(
    "asks on a terminal, refuses without one, and proceeds on --yes before %s",
    (action) => {
      expect(confirmationOf(action, { interactive: true, yes: false })).toBe(
        "ask"
      );
      expect(confirmationOf(action, { interactive: false, yes: false })).toBe(
        "refuse"
      );
      expect(confirmationOf(action, { interactive: false, yes: true })).toBe(
        "proceed"
      );
    }
  );
});
