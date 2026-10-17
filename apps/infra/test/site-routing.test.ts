import { describe, expect, it } from "vitest";

import { siteIndexing, siteRouting } from "../src/site-routing.js";

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

  it.each(["verify-j4-perf", "dev", "production", "Prod"])(
    "leaves %s off the custom domain and serves it on workers.dev",
    (stage) => {
      expect(siteRouting(stage)).toStrictEqual({ workersDev: true });
    }
  );
});

describe("siteIndexing", () => {
  it("lets crawlers index the prod stage", () => {
    expect(siteIndexing("prod")).toBe("index");
  });

  it.each(["verify-j4r5", "dev", "production", "Prod"])(
    "keeps crawlers off %s",
    (stage) => {
      expect(siteIndexing(stage)).toBe("noindex");
    }
  );
});
