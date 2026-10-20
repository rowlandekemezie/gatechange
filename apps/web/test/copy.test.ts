import { describe, expect, it } from "@effect/vitest";

import { bandLabel, thousands } from "../src/client/board/copy.js";

describe("pay copy", () => {
  it("a band reads as currency, low end and high end", () => {
    expect(bandLabel({ currency: "USD", max: 320_000, min: 250_000 })).toBe(
      "USD 250k to 320k"
    );
  });

  it("a band with one stated amount shows that amount once", () => {
    expect(bandLabel({ currency: "CAD", max: 180_000, min: 180_000 })).toBe(
      "CAD 180k"
    );
  });

  it("an amount off the thousand keeps its first decimal", () => {
    expect(thousands(187_500)).toBe("187.5k");
    expect(thousands(150_000)).toBe("150k");
  });
});
