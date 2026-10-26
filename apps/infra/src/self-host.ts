// @effect-diagnostics nodeBuiltinImport:off -- The self-host command runs as plain Node so it can read .env.local and hand off to the pnpm-installed Alchemy CLI.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  isPullRequestStage,
  PROD_STAGE,
  publicOriginOf,
  SITE_WORKERS_SUBDOMAIN,
} from "@rat-stack/core";
import { Option } from "effect";

export type SelfHostEnv = Readonly<Record<string, string | undefined>>;

export const MIN_SELF_HOST_SECRET_LENGTH = 32;

const present = (value: string | undefined) =>
  value !== undefined && value.trim() !== "";

const stageProblems = (stage: string): readonly string[] => {
  if (stage === PROD_STAGE) {
    return [
      `Stage "${PROD_STAGE}" attaches the custom domain in packages/core/src/site.ts. Pick another name, such as --stage self.`,
    ];
  }

  if (stage === "preview" || isPullRequestStage(stage)) {
    return [
      `Stage "${stage}" is reserved for this repository's previews. Pick another name, such as --stage self.`,
    ];
  }

  return /^[a-z][a-z0-9-]{0,39}$/u.test(stage)
    ? []
    : [
        `Stage "${stage}" must be lowercase letters, digits and hyphens, starting with a letter.`,
      ];
};

const credentialProblems = (env: SelfHostEnv): readonly string[] =>
  present(env.ALCHEMY_PROFILE) ||
  (present(env.CLOUDFLARE_API_TOKEN) && present(env.CLOUDFLARE_ACCOUNT_ID))
    ? []
    : [
        "Set ALCHEMY_PROFILE to a profile with Cloudflare credentials, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
      ];

const secretProblems = (env: SelfHostEnv): readonly string[] =>
  (env.BETTER_AUTH_SECRET ?? "").length >= MIN_SELF_HOST_SECRET_LENGTH
    ? []
    : [
        `Set BETTER_AUTH_SECRET to at least ${MIN_SELF_HOST_SECRET_LENGTH} random characters, for example from \`openssl rand -hex 32\`.`,
      ];

const subdomainProblems = (env: SelfHostEnv): readonly string[] => {
  const subdomain = env.WORKERS_SUBDOMAIN ?? "";

  if (!present(subdomain)) {
    return [
      "Set WORKERS_SUBDOMAIN to your account's workers.dev subdomain (Workers & Pages > Overview in the Cloudflare dashboard).",
    ];
  }

  return subdomain === SITE_WORKERS_SUBDOMAIN
    ? []
    : [
        `Set SITE_WORKERS_SUBDOMAIN in packages/core/src/site.ts to "${subdomain}". The site trusts its own links and sign-in host only on that subdomain.`,
      ];
};

export const selfHostProblems = (
  stage: string,
  env: SelfHostEnv
): readonly string[] => [
  ...stageProblems(stage),
  ...credentialProblems(env),
  ...secretProblems(env),
  ...subdomainProblems(env),
];

export const selfHostOrigin = (stage: string, env: SelfHostEnv) =>
  publicOriginOf(stage, Option.fromUndefinedOr(env.WORKERS_SUBDOMAIN));

const AFTER_ACTION = {
  deploy: (stage: string, origin: Option.Option<string>) =>
    `Deployed stage "${stage}". Open ${Option.getOrElse(origin, () => "the workers.dev URL above")}; the board fills over the next few cron runs.`,
  destroy: (stage: string) => `Removed every resource of stage "${stage}".`,
  plan: (stage: string) =>
    `Plan finished. Review it, then run pnpm self-host deploy --stage ${stage}.`,
} as const;

type SelfHostAction = keyof typeof AFTER_ACTION;

const isAction = (value: string | undefined): value is SelfHostAction =>
  value !== undefined && Object.hasOwn(AFTER_ACTION, value);

const selfHost = () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { stage: { default: "self", type: "string" } },
  });

  const [action = "plan"] = positionals;

  if (!isAction(action)) {
    process.stderr.write(
      `Usage: pnpm self-host [plan|deploy|destroy] --stage <name>\n`
    );

    return 1;
  }

  if (existsSync(".env.local")) {
    process.loadEnvFile(".env.local");
  }

  const { stage } = values;

  const problems = selfHostProblems(stage, process.env);

  if (problems.length > 0) {
    process.stderr.write(
      `Not ready to ${action} stage "${stage}":\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`
    );

    return 1;
  }

  const run = spawnSync(
    "pnpm",
    [
      "--filter",
      "@rat-stack/infra",
      "exec",
      "alchemy",
      action,
      "--stage",
      stage,
    ],
    { stdio: "inherit" }
  );

  if (run.status === 0) {
    process.stdout.write(
      `${AFTER_ACTION[action](stage, selfHostOrigin(stage, process.env))}\n`
    );
  }

  return run.status ?? 1;
};

if (import.meta.main) {
  process.exitCode = selfHost();
}
