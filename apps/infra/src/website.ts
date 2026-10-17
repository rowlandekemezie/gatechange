import JobsBackend from "@rat-stack/api/worker";
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
          "/rpc",
          "/rpc/*",
          "/jobs/*",
          "/companies/*",
          "/roles/*",
          "/sitemap.xml",
          "/robots.txt",
        ],
      },
      ...siteRouting(stage),
      env: { BACKEND: JobsBackend, SITE_INDEXING: siteIndexing(stage) },
      main: "src/worker.ts",
      rootDir: "../web",
    };
  })
) {}
