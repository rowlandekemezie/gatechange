import { describe, expect, it } from "@effect/vitest";

import { PRO_PRODUCT_DESCRIPTION } from "../src/index.js";

describe("Pro product shown on Checkout", () => {
  it("names the shipped Pro alerts, filters and company intel", () => {
    expect([
      /seniority/iu.test(PRO_PRODUCT_DESCRIPTION),
      /intel/iu.test(PRO_PRODUCT_DESCRIPTION),
      /floor/iu.test(PRO_PRODUCT_DESCRIPTION),
      PRO_PRODUCT_DESCRIPTION.includes("up to 6 a day"),
      PRO_PRODUCT_DESCRIPTION.includes("roles that state a salary"),
    ]).toEqual([true, true, true, true, true]);
  });
});
