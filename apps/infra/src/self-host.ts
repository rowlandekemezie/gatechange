// @effect-diagnostics nodeBuiltinImport:off -- The self-host command runs as plain Node so it can read the Alchemy profile on disk, prompt on the terminal and hand off to the pnpm-installed Alchemy CLI.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  isPullRequestStage,
  PROD_STAGE,
  publicOriginOf,
  WorkersSubdomain,
} from "@rat-stack/core";
import { Data, Match, Option, Schema } from "effect";

export type SelfHostEnv = Readonly<Record<string, string | undefined>>;

export const MIN_SELF_HOST_SECRET_LENGTH = 32;

const present = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== "";

export type CredentialSourceValue = Data.TaggedEnum<{
  Environment: { readonly accountId: string };
  None: Record<never, never>;
  Profile: {
    readonly accountId: Option.Option<string>;
    readonly profile: string;
  };
}>;

export const CredentialSource = Data.taggedEnum<CredentialSourceValue>();

export const credentialSourceOf = (
  env: SelfHostEnv,
  profileAccountId: (profile: string) => Option.Option<string>
): CredentialSourceValue => {
  if (
    present(env.CLOUDFLARE_ACCOUNT_ID) &&
    (present(env.CLOUDFLARE_API_TOKEN) || present(env.CLOUDFLARE_API_KEY))
  ) {
    return CredentialSource.Environment({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
    });
  }

  return present(env.ALCHEMY_PROFILE)
    ? CredentialSource.Profile({
        accountId: profileAccountId(env.ALCHEMY_PROFILE),
        profile: env.ALCHEMY_PROFILE,
      })
    : CredentialSource.None();
};

const ProfileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const CloudflareProfile = Schema.fromJsonString(
  Schema.Struct({ values: Schema.Struct({ accountId: Schema.String }) })
);

export const profileAccountIdIn =
  (alchemyHome: string, read: (file: string) => Option.Option<string>) =>
  (profile: string): Option.Option<string> =>
    ProfileName.test(profile)
      ? read(
          path.join(alchemyHome, "profiles", profile, "cloudflare.json")
        ).pipe(
          Option.flatMap(Schema.decodeOption(CloudflareProfile)),
          Option.map(({ values }) => values.accountId)
        )
      : Option.none();

const readIfPresent = (file: string) =>
  existsSync(file) ? Option.some(readFileSync(file, "utf-8")) : Option.none();

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

const credentialProblems = (source: CredentialSourceValue): readonly string[] =>
  Match.valueTags(source, {
    Environment: () => [],
    None: () => [
      "Set ALCHEMY_PROFILE to a profile with Cloudflare credentials, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
    ],
    Profile: ({ accountId, profile }) =>
      Option.isSome(accountId)
        ? []
        : [
            `Alchemy profile "${profile}" has no Cloudflare account. Run pnpm alchemy profile edit --profile ${profile} --add Cloudflare.`,
          ],
  });

const secretProblems = (env: SelfHostEnv): readonly string[] =>
  (env.BETTER_AUTH_SECRET ?? "").length >= MIN_SELF_HOST_SECRET_LENGTH
    ? []
    : [
        `Set BETTER_AUTH_SECRET to at least ${MIN_SELF_HOST_SECRET_LENGTH} random characters, for example from \`openssl rand -hex 32\`.`,
      ];

const subdomainProblems = ({
  WORKERS_SUBDOMAIN: subdomain,
}: SelfHostEnv): readonly string[] => {
  if (!present(subdomain)) {
    return [
      "Set WORKERS_SUBDOMAIN to your account's workers.dev subdomain (Workers & Pages > Overview in the Cloudflare dashboard). The build trusts it as the site's own host.",
    ];
  }

  return Option.isSome(Schema.decodeOption(WorkersSubdomain)(subdomain))
    ? []
    : [
        `WORKERS_SUBDOMAIN "${subdomain}" is not a workers.dev subdomain. Use lowercase letters, digits and hyphens, as in <subdomain>.workers.dev.`,
      ];
};

export const selfHostProblems = (
  stage: string,
  env: SelfHostEnv,
  source: CredentialSourceValue
): readonly string[] => [
  ...stageProblems(stage),
  ...credentialProblems(source),
  ...secretProblems(env),
  ...subdomainProblems(env),
];

export const selfHostOrigin = (stage: string, env: SelfHostEnv) =>
  publicOriginOf(stage, Option.fromUndefinedOr(env.WORKERS_SUBDOMAIN));

export const targetSummary = (
  action: string,
  stage: string,
  env: SelfHostEnv,
  source: CredentialSourceValue
): string => {
  const credentials = Match.valueTags(source, {
    Environment: () =>
      `environment variables CLOUDFLARE_ACCOUNT_ID and ${present(env.CLOUDFLARE_API_TOKEN) ? "CLOUDFLARE_API_TOKEN" : "CLOUDFLARE_API_KEY"}${present(env.ALCHEMY_PROFILE) ? ` (they override ALCHEMY_PROFILE "${env.ALCHEMY_PROFILE}")` : ""}`,
    None: () => "none",
    Profile: ({ profile }) => `Alchemy profile "${profile}"`,
  });

  const account = Match.valueTags(source, {
    Environment: ({ accountId }) => accountId,
    None: () => "unknown",
    Profile: ({ accountId }) => Option.getOrElse(accountId, () => "unknown"),
  });

  return [
    `About to ${action} stage "${stage}".`,
    `  Credentials:        ${credentials}`,
    `  Cloudflare account: ${account}`,
    `  Site:               ${Option.getOrElse(selfHostOrigin(stage, env), () => "unknown")}`,
    "Check that this is your own account before you continue.",
  ].join("\n");
};

export type SelfHostAction = "deploy" | "destroy" | "plan";

export const confirmationOf = (
  action: SelfHostAction,
  { interactive, yes }: { readonly interactive: boolean; readonly yes: boolean }
): "ask" | "proceed" | "refuse" => {
  if (action === "plan" || yes) {
    return "proceed";
  }

  return interactive ? "ask" : "refuse";
};

const AFTER_ACTION = {
  deploy: (stage: string, origin: Option.Option<string>) =>
    `Deployed stage "${stage}". Open ${Option.getOrElse(origin, () => "the workers.dev URL above")}; the board fills over the next few cron runs.`,
  destroy: (stage: string) => `Removed every resource of stage "${stage}".`,
  plan: (stage: string) =>
    `Plan finished. Review it, then run pnpm self-host deploy --stage ${stage}.`,
} as const;

const isAction = (value: string | undefined): value is SelfHostAction =>
  value !== undefined && Object.hasOwn(AFTER_ACTION, value);

const confirmed = (action: SelfHostAction, stage: string) => {
  process.stdout.write(
    `Type y to ${action} stage "${stage}" on this account [y/N] `
  );

  const terminal = openSync("/dev/tty", "r");
  const answer = Buffer.alloc(64);

  try {
    const length = readSync(terminal, answer, 0, answer.length, null);

    return answer.toString("utf-8", 0, length).trim().toLowerCase() === "y";
  } finally {
    closeSync(terminal);
  }
};

const run = (args: readonly string[]) =>
  spawnSync("pnpm", args, { stdio: "inherit" }).status ?? 1;

const USAGE =
  "Usage: pnpm self-host [plan|deploy|destroy] --stage <name> [--yes]\n";

const selfHost = () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { default: false, short: "h", type: "boolean" },
      stage: { default: "self", type: "string" },
      yes: { default: false, type: "boolean" },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);

    return 0;
  }

  const [action = "plan"] = positionals;

  if (!isAction(action)) {
    process.stderr.write(USAGE);

    return 1;
  }

  const { stage, yes } = values;
  const { env } = process;

  const source = credentialSourceOf(
    env,
    profileAccountIdIn(
      env.ALCHEMY_HOME ?? path.join(homedir(), ".alchemy"),
      readIfPresent
    )
  );

  const problems = selfHostProblems(stage, env, source);

  if (problems.length > 0) {
    process.stderr.write(
      `Not ready to ${action} stage "${stage}":\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`
    );

    return 1;
  }

  process.stdout.write(`${targetSummary(action, stage, env, source)}\n`);

  const decision = confirmationOf(action, {
    interactive: process.stdin.isTTY,
    yes,
  });

  if (decision === "refuse") {
    process.stderr.write(
      `Refusing to ${action} without confirmation. Re-run with --yes once the account above is yours.\n`
    );

    return 1;
  }

  if (decision === "ask" && !confirmed(action, stage)) {
    process.stderr.write(`Stopped. Nothing was ${action}ed.\n`);

    return 1;
  }

  const built = run(["turbo", "run", "build", "--filter=@rat-stack/infra..."]);

  if (built !== 0) {
    return built;
  }

  const status = run([
    "--filter",
    "@rat-stack/infra",
    "exec",
    "alchemy",
    action,
    "--stage",
    stage,
    "--env-file",
    "/dev/null",
  ]);

  if (status === 0) {
    process.stdout.write(
      `${AFTER_ACTION[action](stage, selfHostOrigin(stage, env))}\n`
    );
  }

  return status;
};

if (import.meta.main) {
  process.exitCode = selfHost();
}
