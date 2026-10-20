import JobsBackend from "@rat-stack/api/worker";
import {
  ANONYMOUS_MCP_CALLS_PER_MINUTE,
  TOKEN_MCP_CALLS_PER_MINUTE,
} from "@rat-stack/core";
import { workerFirstPaths } from "@rat-stack/web/edge-routes";
import { Stage } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { siteIndexing, siteRouting } from "./site-routing.js";

export class Website extends Cloudflare.Website.Foldkit<Website>()(
  "Website",
  Effect.gen(function* websiteProps() {
    const stage = yield* Stage;

    return {
      assets: {
        notFoundHandling: "single-page-application" as const,
        runWorkerFirst: [
          ...workerFirstPaths,
          "/jobs/*",
          "/companies/*",
          "/roles/*",
          "/sitemap.xml",
          "/robots.txt",
        ],
      },
      ...siteRouting(stage),
      env: {
        BACKEND: JobsBackend,
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
        SITE_INDEXING: siteIndexing(stage),
      },
      main: "src/worker.ts",
      rootDir: "../web",
    };
  })
) {}
