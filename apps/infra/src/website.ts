import JobsBackend from "@rat-stack/api/worker";
import * as Cloudflare from "alchemy/Cloudflare";

export const SITE_HOSTNAME = "jobs.rowlandekemezie.com";

export const SITE_ZONE = "rowlandekemezie.com";

export class Website extends Cloudflare.Website.Foldkit<Website>()("Website", {
  assets: {
    notFoundHandling: "single-page-application",
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
  domain: { name: SITE_HOSTNAME, zoneName: SITE_ZONE },
  env: { BACKEND: JobsBackend },
  main: "src/worker.ts",
  rootDir: "../web",
  workersDev: false,
}) {}
