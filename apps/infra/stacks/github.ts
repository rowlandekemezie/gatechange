import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const REPOSITORY = { owner: "rowlandekemezie", repository: "jobs" } as const;

export default Alchemy.Stack(
  "JobBoardCi",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* ciCredentials() {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

    const deployToken = yield* Cloudflare.ApiToken.AccountApiToken("JobBoardDeployToken", {
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            "Workers KV Storage Write",
            "Workers R2 Storage Write",
            "D1 Write",
            "Account Settings Write",
            "Secrets Store Write",
            "Workers Tail Read",
          ],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
        {
          effect: "allow",
          permissionGroups: ["Zone Read", "DNS Write", "Workers Routes Write"],
          resources: { "com.cloudflare.api.account.zone.*": "*" },
        },
      ],
    });

    yield* GitHub.Secret("CloudflareApiToken", {
      ...REPOSITORY,
      name: "CLOUDFLARE_API_TOKEN",
      value: deployToken.value,
    });

    yield* GitHub.Secret("CloudflareAccountId", {
      ...REPOSITORY,
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: Redacted.make(accountId),
    });

    return { tokenName: "JobBoardDeployToken" };
  })
);
