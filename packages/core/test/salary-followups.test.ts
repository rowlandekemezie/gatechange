import { describe, expect, it } from "@effect/vitest";

import { detailsOfAnswer } from "../src/enrichment.js";

const salaryOf = (text: string, min = 150_000, max = 200_000) =>
  detailsOfAnswer(
    {
      handsOn: null,
      handsOnQuote: null,
      remotePolicy: null,
      remotePolicyQuote: null,
      reportsTo: null,
      reportsToQuote: null,
      salaryMax: max,
      salaryMin: min,
      seniority: null,
      teamSize: null,
      teamSizeQuote: null,
    },
    {
      company: "Acme",
      salary: null,
      text,
      title: "Engineering Manager",
      workplace: "Unspecified",
    }
  ).salary;

const band = "$150,000 - $200,000";

const zones = `Target pay ranges based on Geographic Zones:
Zone 1: Seattle - ${band}
Zone 2: Austin - $120,000 - $160,000`;

describe("salary evidence", () => {
  it.each([
    ["dash range", "Compensation: $1 50,000 - $200,000", 50_000, 200_000],
    ["k range", "Compensation: $1 50k - $200k", 50_000, 200_000],
    ["currency code", "Compensation: USD 1 50,000 - $200,000", 50_000, 200_000],
  ])("rejects an amount split by a space in a %s", (_, text, min, max) => {
    expect(salaryOf(text, min, max)).toBeNull();
  });

  it.each([
    ["space after the symbol", "Compensation: $ 150,000 - $200,000"],
    [
      "unrelated dollar figure before the range",
      "Compensation: from $5, then 150,000 - $200,000",
    ],
    [
      "second amount with its own symbol",
      "Compensation: $1 $150,000 - $200,000",
    ],
  ])("keeps a band with %s", (_, text) => {
    expect(salaryOf(text)).toStrictEqual({
      currency: "USD",
      max: 200_000,
      min: 150_000,
    });
  });

  it.each([
    [
      "OTE statement before a base component explanation",
      `Our current hiring range: $120,000 - $160,000 OTE annually. OTE is the sum of a fixed base salary plus incentives.\nWe share our broader geographic salary bands.\nWe have two geographic pay zones:\nZone 1: Seattle - ${band}`,
    ],
    ["bonus footnote", `${zones}\nAll Zones Inclusive of a 15% Bonus Target`],
    [
      "OTE above the zone heading",
      `Our current hiring range: $120,000 - $160,000 OTE annually.\nWe share our broader geographic salary bands.\nWe have two geographic pay zones:\nZone 1: Seattle - ${band}`,
    ],
    ["total cash suffix", `Compensation: ${band} total cash including bonus`],
    ["equity value suffix", `Compensation: ${band} equity value`],
    ["bullet OTE suffix", `Compensation: ${band} • OTE`],
  ])("rejects %s", (_, text) => {
    expect(salaryOf(text)).toBeNull();
  });

  it.each([
    ["ordinary zone table", zones],
    [
      "quota responsibility without an inclusive-pay claim",
      `You are accountable for hitting quota.\n${zones}`,
    ],
    [
      "meeting resource quotas",
      `You design infrastructure for meeting resource quotas.\n${zones}`,
    ],
    [
      "negated quota responsibility",
      `You are not responsible for hitting quota.\n${zones}`,
    ],
    [
      "technical quotas",
      `You model entitlements, quotas, and multi-tenant limits.\n${zones}`,
    ],
    [
      "explicit base for a quota-carrying role",
      `You are accountable for hitting quota.\nBase pay ranges based on Geographic Zones:\nZone 1: Seattle - ${band}`,
    ],
    [
      "bonus excluded from zones",
      `${zones}\nAll Zones Exclusive of a 15% Bonus Target`,
    ],
    [
      "bonus note below another section",
      `${zones}\nBenefits:\nAll Zones Inclusive of a 15% Bonus Target`,
    ],
    [
      "base table after a different OTE table",
      `Annual OTE: $120,000 - $160,000\nBase salary ranges:\nZone 1: Seattle - ${band}`,
    ],
    [
      "a second independent table",
      `Target pay ranges:\nZone 1: Austin - $120,000 - $160,000\nAll Zones Inclusive of a 15% Bonus Target\nBase salary ranges:\nZone 1: Seattle - ${band}`,
    ],
    ["base plus bonus", `Compensation: ${band} plus bonus`],
    ["base excluding bonus", `Compensation: ${band}, excluding bonus`],
  ])("preserves %s", (_, text) => {
    expect(salaryOf(text)).toStrictEqual({
      currency: "USD",
      max: 200_000,
      min: 150_000,
    });
  });
});
