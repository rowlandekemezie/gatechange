import { describe, expect, it } from "vitest";

import { siteRouting } from "../src/site-routing.js";

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
