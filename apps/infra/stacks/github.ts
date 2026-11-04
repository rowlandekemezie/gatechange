import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const REPOSITORY = {
  owner: "rowlandekemezie",
  repository: "jobs",
} as const;

const accountResource = (accountId: string) =>
  ({ [`com.cloudflare.api.account.${accountId}`]: "*" }) as const;

export default Alchemy.Stack(
  "JobBoardCi",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* ciCredentials() {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

    const deployToken = yield* Cloudflare.ApiToken.AccountApiToken(
      "JobBoardDeployToken",
      {
        accountId,
        policies: [
          {
            effect: "allow",
            permissionGroups: [
              "Workers Scripts Write",
              "Workers KV Storage Write",
              "Workers R2 Storage Write",
              "D1 Write",
              "Queues Write",
              "Account Settings Write",
              "Secrets Store Write",
              "Workers Tail Read",
            ],
            resources: accountResource(accountId),
          },
          {
            effect: "allow",
            permissionGroups: [
              "Zone Read",
              "DNS Write",
              "Workers Routes Write",
            ],
            resources: { "com.cloudflare.api.account.zone.*": "*" },
          },
        ],
      }
    );

    const pullRequestToken = yield* Cloudflare.ApiToken.AccountApiToken(
      "JobBoardPrPreviewToken",
      {
        accountId,
        policies: [
          {
            effect: "allow",
            permissionGroups: [
              "Workers Scripts Write",
              "Secrets Store Write",
              "Account Settings Read",
            ],
            resources: accountResource(accountId),
          },
        ],
      }
    );

    const previewToken = yield* Cloudflare.ApiToken.AccountApiToken(
      "JobBoardPreviewToken",
      {
        accountId,
        policies: [
          {
            effect: "allow",
            permissionGroups: [
              "Workers Scripts Write",
              "Workers KV Storage Write",
              "Workers R2 Storage Write",
              "D1 Write",
              "Queues Write",
              "Account Settings Write",
              "Secrets Store Write",
            ],
            resources: accountResource(accountId),
          },
        ],
      }
    );

    const pullRequestEnvironment = yield* GitHub.Environment(
      "PrPreviewEnvironment",
      { ...REPOSITORY, name: "pr-preview" }
    );

    yield* GitHub.Secret("CloudflareApiToken", {
      ...REPOSITORY,
      environment: "production",
      name: "CLOUDFLARE_API_TOKEN",
      value: deployToken.value,
    });

    yield* GitHub.Secret("PreviewCloudflareApiToken", {
      ...REPOSITORY,
      environment: "preview",
      name: "PREVIEW_CLOUDFLARE_API_TOKEN",
      value: previewToken.value,
    });

    yield* GitHub.Secret("PrPreviewCloudflareApiToken", {
      ...REPOSITORY,
      environment: pullRequestEnvironment,
      name: "PR_PREVIEW_CLOUDFLARE_API_TOKEN",
      value: pullRequestToken.value,
    });

    yield* GitHub.Secret("CloudflareAccountId", {
      ...REPOSITORY,
      name: "CLOUDFLARE_ACCOUNT_ID",
      value: Redacted.make(accountId),
    });

    return { tokenName: "JobBoardDeployToken" };
  })
);
