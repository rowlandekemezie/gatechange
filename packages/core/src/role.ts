import { Match, Option } from "effect";

import type { RoleLevel } from "./job.js";

const engineeringScope =
  "(?:engineering|software|platform|infrastructure|development|technology|technical|data (?:engineering|platform|infrastructure)|machine learning|ml|ai|security|devops|sre|site reliability|backend|frontend|mobile|cloud)";

const excludedFunction =
  /\b(?:sales|solutions?|customers?|support|accounts?|field|recruit\w*|talent|marketing|partners?|program|project|product manager|products? marketing|intern(?:ship)?|success|pre-?sales|professional services|implementation|enablement|operations manager|facilities|finance|legal|people)\b/iu;

const vicePresident = new RegExp(
  String.raw`\b(?:s?vp|evp|vice[\s-]+president)\b[\s\S]*\b${engineeringScope}\b`,
  "iu"
);

const headOfEngineering = new RegExp(
  String.raw`\bhead\s+of\s+(?:[a-z]+\s+){0,2}${engineeringScope}\b`,
  "iu"
);

const director = new RegExp(
  String.raw`(?:\bdirectors?\b[\s\S]*\b${engineeringScope}\b|\b${engineeringScope}\s+directors?\b)`,
  "iu"
);

const engineeringManager = new RegExp(
  String.raw`(?:\b${engineeringScope}(?:\s+engineering)?\s+managers?\b|\bmanagers?\b[\s,]*(?:of\s+|ii?\s*,\s*)?(?:[a-z]+\s+){0,2}${engineeringScope}\b|\bem\b)`,
  "iu"
);

const rolePatterns: ReadonlyArray<readonly [RoleLevel, RegExp]> = [
  ["VicePresident", vicePresident],
  ["HeadOfEngineering", headOfEngineering],
  ["Director", director],
  ["EngineeringManager", engineeringManager],
];

export const classifyRole = (title: string): Option.Option<RoleLevel> => {
  if (excludedFunction.test(title)) {
    return Option.none();
  }

  for (const [level, pattern] of rolePatterns) {
    if (pattern.test(title)) {
      return Option.some(level);
    }
  }

  return Option.none();
};

export const roleWeight = Match.type<RoleLevel>().pipe(
  Match.when("VicePresident", () => 40),
  Match.when("HeadOfEngineering", () => 38),
  Match.when("Director", () => 36),
  Match.when("EngineeringManager", () => 30),
  Match.exhaustive
);
