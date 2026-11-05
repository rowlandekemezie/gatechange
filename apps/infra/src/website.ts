import JobsBackend from "@rat-stack/api/worker";
import {
  ANONYMOUS_MCP_CALLS_PER_MINUTE,
  isPullRequestStage,
  postHogSetting,
  PUBLIC_READS_PER_MINUTE,
  TOKEN_MCP_CALLS_PER_MINUTE,
} from "@rat-stack/core";
import {
  HASHED_ASSET_CACHE_CONTROL,
  HASHED_ASSET_PATHS,
} from "@rat-stack/web/edge-routes";
import { Stage } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { siteIndexing, siteRouting, siteWorkerFirst } from "./site-routing.js";

export class Website extends Cloudflare.Website.Foldkit<Website>()(
  "Website",
  Effect.gen(function* websiteProps() {
    const stage = yield* Stage;
    const pullRequest = isPullRequestStage(stage);

    const routing = pullRequest
      ? {
          compatibility: { flags: ["global_fetch_strictly_public"] },
          preview: {
            name: stage,
            of: yield* Cloudflare.Worker.ref("Website", { stage: "preview" }),
          },
        }
      : siteRouting(stage);

    const backendBindings = pullRequest
      ? {
          PR_PREVIEW_BACKEND_URL: JobsBackend.pipe(
            Effect.map((backend) =>
              backend.url.pipe(Output.map((url) => url ?? ""))
            )
          ),
          PR_PREVIEW_SECRET: yield* Config.Redacted("PR_PREVIEW_SECRET").pipe(
            Effect.orDie
          ),
        }
      : { BACKEND: JobsBackend };

    const analytics = Option.match(yield* postHogSetting.pipe(Effect.orDie), {
      onNone: () => ({}),
      onSome: ({ key, region }) => ({
        POSTHOG_PROJECT_KEY: key,
        POSTHOG_REGION: region,
      }),
    });

    return {
      assets: {
        headers: `${HASHED_ASSET_PATHS}\n  Cache-Control: ${HASHED_ASSET_CACHE_CONTROL}\n`,
        notFoundHandling: "none" as const,
        runWorkerFirst: siteWorkerFirst(stage),
      },
      ...routing,
      env: {
        ...backendBindings,
        ...analytics,
        MCP_ANONYMOUS_LIMIT: Cloudflare.Workers.RateLimit(
          "MCP_ANONYMOUS_LIMIT",
          {
            namespaceId: 1201,
            simple: { limit: ANONYMOUS_MCP_CALLS_PER_MINUTE, period: 60 },
          }
        ),
        MCP_TOKEN_LIMIT: Cloudflare.Workers.RateLimit("MCP_TOKEN_LIMIT", {
          namespaceId: 1202,
          simple: { limit: TOKEN_MCP_CALLS_PER_MINUTE, period: 60 },
        }),
        PUBLIC_READ_LIMIT: Cloudflare.Workers.RateLimit("PUBLIC_READ_LIMIT", {
          namespaceId: 1203,
          simple: { limit: PUBLIC_READS_PER_MINUTE, period: 60 },
        }),
        SESSION_READ_LIMIT: Cloudflare.Workers.RateLimit("SESSION_READ_LIMIT", {
          namespaceId: 1204,
          simple: { limit: PUBLIC_READS_PER_MINUTE, period: 60 },
        }),
        SITE_INDEXING: siteIndexing(stage),
      },
      main: "src/worker.ts",
      rootDir: "../web",
    };
  })
) {}
