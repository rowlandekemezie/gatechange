import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import {
  classifyPlacement,
  classifyRole,
  seniorityOfTitle,
} from "../src/index.js";
import type {
  ArrangementValue,
  RegionValue,
  RoleLevelValue,
  SeniorityValue,
} from "../src/index.js";

const leadershipTitles: readonly (readonly [string, RoleLevelValue])[] = [
  ["VP of Engineering", "VicePresident"],
  ["SVP, Software Development", "VicePresident"],
  ["Head of Platform Engineering", "HeadOfEngineering"],
  ["Senior Director, Software Engineering", "Director"],
  ["Engineering Director", "Director"],
  ["Senior Engineering Manager, Payments", "EngineeringManager"],
  ["Manager II, Engineering", "EngineeringManager"],
  ["Software Development Manager", "EngineeringManager"],
  ["Manager, Site Reliability Engineering", "EngineeringManager"],
];

const titleSeniorities: readonly (readonly [string, SeniorityValue])[] = [
  ["Global Financial Operations Platform Director", "Director"],
  ["Senior Director, Security Architecture", "SeniorDirector"],
  ["Sr. Engineering Director", "SeniorDirector"],
  ["Director, Senior Software Engineering", "Director"],
  ["SVP, Software Development", "VicePresident"],
  ["Vice President of Engineering", "VicePresident"],
  ["Chief Technology Officer", "Executive"],
  ["Senior Engineering Manager, Payments", "SeniorManager"],
  ["Manager, Starlink Engineering (Starlink PCBA SMT)", "Manager"],
  ["Engineering Manager, Office of the CTO", "Manager"],
  ["Senior Director of Engineering, reporting to the CEO", "SeniorDirector"],
  ["Director, Office of the VP of Engineering", "Director"],
  ["CTO", "Executive"],
  ["Manager II, Engineering", "Manager"],
];

const otherTitles = [
  "Product Manager, Platform",
  "Technical Program Manager",
  "Sales Engineering Manager",
  "Solutions Engineering Manager",
  "Director, Product Design",
  "Director of Data Science",
  "Staff Software Engineer",
  "Engineering Lead",
];

const placements: readonly (readonly [
  string,
  ArrangementValue,
  ArrangementValue,
  RegionValue,
])[] = [
  ["Remote - Canada", "Unspecified", "Remote", "RemoteCanada"],
  ["Remote - US or Canada", "Unspecified", "Remote", "RemoteNorthAmerica"],
  ["United States", "Remote", "Remote", "RemoteUnitedStates"],
  [
    "Vancouver, British Columbia, Canada",
    "Hybrid",
    "Hybrid",
    "BritishColumbia",
  ],
  ["Toronto, ON", "Unspecified", "Unspecified", "CanadaOnsite"],
  ["Hybrid - Seattle, WA", "Unspecified", "Hybrid", "UnitedStatesOnsite"],
  ["Remote (EMEA)", "Unspecified", "Remote", "Elsewhere"],
  ["Remote", "Unspecified", "Remote", "RemoteGlobal"],
];

describe("seniority from a title", () => {
  it.each(titleSeniorities)("%s is %s", (title, seniority) => {
    expect(seniorityOfTitle(title)).toStrictEqual(Option.some(seniority));
  });

  it.each([
    "Head of Platform Engineering",
    "Head of Engineering",
    "Head of Engineering, Office of the CTO",
    "Chief of Staff",
    "Chief of Staff to the CTO",
    "Staff Engineer",
  ])("%s states no level in its own words", (title) => {
    expect(seniorityOfTitle(title)).toStrictEqual(Option.none());
  });
});

describe("role classification", () => {
  it.each(leadershipTitles)("%s is %s", (title, role) => {
    expect(classifyRole(title)).toStrictEqual(Option.some(role));
  });

  it.each(otherTitles)("%s is not an engineering leadership role", (title) => {
    expect(classifyRole(title)).toStrictEqual(Option.none());
  });

  it.prop(
    "a sales, solutions, or program title is never classified as leadership",
    {
      prefix: Schema.Literals([
        "Sales",
        "Solutions",
        "Customer Success",
        "Technical Program",
      ]),
      role: Schema.Literals([
        "Engineering Manager",
        "Director of Engineering",
        "VP Engineering",
      ]),
    },
    ({ prefix, role }) => {
      expect(classifyRole(`${prefix} ${role}`)).toStrictEqual(Option.none());
    }
  );
});

describe("placement classification", () => {
  it.each(placements)(
    "%s (%s) is %s in %s",
    (text, workplace, arrangement, region) => {
      expect(classifyPlacement({ text, workplace })).toStrictEqual({
        arrangement,
        region,
      });
    }
  );

  it.prop(
    "a source's own workplace flag wins over words in the location text",
    { workplace: Schema.Literals(["Remote", "Hybrid", "Onsite"]) },
    ({ workplace }) => {
      expect(
        classifyPlacement({ text: "Remote, hybrid or on-site", workplace })
          .arrangement
      ).toBe(workplace);
    }
  );
});
