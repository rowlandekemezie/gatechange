import { describe, expect, it } from "vitest";

import {
  siteIndexing,
  siteRouting,
  siteWorkerFirst,
} from "../src/site-routing.js";

describe("siteRouting", () => {
  it("attaches the production domain only to the prod stage, with workers.dev off", () => {
    expect(siteRouting("prod")).toStrictEqual({
      domain: {
        name: "jobs.rowlandekemezie.com",
        zoneName: "rowlandekemezie.com",
      },
      workersDev: false,
    });
  });

  it.each(["preview", "verify-j4-perf", "dev", "production", "Prod"])(
    "leaves %s off the custom domain and serves it on its own workers.dev name",
    (stage) => {
      expect(siteRouting(stage)).toStrictEqual({
        name: `jobs-${stage.toLowerCase()}`,
        workersDev: true,
      });
    }
  );
});

describe("siteIndexing", () => {
  it("lets crawlers index the prod stage", () => {
    expect(siteIndexing("prod")).toBe("index");
  });

  it.each(["preview", "verify-j4r5", "dev", "production", "Prod"])(
    "keeps crawlers off %s",
    (stage) => {
      expect(siteIndexing(stage)).toBe("noindex");
    }
  );
});

describe("siteWorkerFirst", () => {
  it("preserves production's existing selected paths", () => {
    expect(siteWorkerFirst("prod")).toStrictEqual([
      "/rpc",
      "/rpc/*",
      "/mcp",
      "/mcp/*",
      "/.well-known/mcp.json",
      "/.well-known/mcp.json/*",
      "/api/auth",
      "/api/auth/*",
      "/unsubscribe",
      "/unsubscribe/*",
      "/webhooks/stripe",
      "/webhooks/stripe/*",
      "/account",
      "/account/*",
      "/jobs/*",
      "/companies/*",
      "/roles/*",
      "/sitemap.xml",
      "/robots.txt",
    ]);
  });

  it.each(["preview", "verify-x", "dev", "Prod"])(
    "routes all %s pages and static assets through the noindex handler",
    (stage) => {
      expect(siteWorkerFirst(stage)).toBe(true);
      expect(siteIndexing(stage)).toBe("noindex");
    }
  );
});
