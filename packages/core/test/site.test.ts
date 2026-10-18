import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { siteHostsOf } from "../src/index.js";

describe("siteHostsOf", () => {
  it("trusts exactly the prod domain on prod, whatever local hosts are set", () => {
    expect(siteHostsOf("prod", ["localhost:*"])).toStrictEqual({
      allowedHosts: ["jobs.rowlandekemezie.com"],
      fallbackOrigin: Option.some("https://jobs.rowlandekemezie.com"),
    });
  });

  it.each(["verify-j7r3", "dev", "Prod"])(
    "trusts only %s's own workers.dev name and local hosts, never prod",
    (stage) => {
      const hosts = siteHostsOf(stage, ["localhost:*"]);

      expect(hosts).toStrictEqual({
        allowedHosts: [
          `jobs-${stage.toLowerCase()}.*.workers.dev`,
          "localhost:*",
        ],
        fallbackOrigin: Option.none(),
      });
    }
  );
});
