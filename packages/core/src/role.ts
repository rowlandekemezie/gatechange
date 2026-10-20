import { Array, Match, Option, pipe } from "effect";

import type { RoleLevelValue, SeniorityValue } from "./job.js";

const engineeringScope =
  "(?:engineering|software|platform|infrastructure|(?:software|application|systems?) development|technology|technical|data (?:engineering|platform|infrastructure)|machine learning|ml|ai|security|devops|sre|site reliability|backend|frontend|mobile|cloud)";

const excludedFunction =
  /\b(?:sales|solutions?|customers?|support|accounts?|field|recruit\w*|talent|marketing|partners?|program|project|product manager|products? marketing|intern(?:ship)?|success|pre-?sales|professional services|implementation|enablement|operations manager|facilities|finance|legal|people)\b/iu;

const nonEngineeringLeadership =
  /^\s*(?:(?:senior|sr\.?|global|group|executive)\s+)*(?:directors?|managers?|s?vp|evp|vice[\s-]+president|head)\s*(?:of\s+|,\s*)?(?:products?|physical\s+security(?:\s*(?:&|and)\s+safety)?)(?=\s*(?:[,|:/–—-]|$))/iu;

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
  String.raw`(?:\b${engineeringScope}(?:\s+engineering)?\s+managers?\b|\bmanagers?\b[\s,]*(?:of\s+|ii?\s*,\s*)?(?:[a-z]+\s+){0,2}${engineeringScope}\b)`,
  "iu"
);

const engineeringManagerAbbreviation =
  /^(?:(?:[Ss]enior|[Ss]r\.?)\s+)?EM(?:\s*[-,(]|\s*$)/u;

const rolePatterns: readonly (readonly [RoleLevelValue, RegExp])[] = [
  ["VicePresident", vicePresident],
  ["HeadOfEngineering", headOfEngineering],
  ["Director", director],
  ["EngineeringManager", engineeringManager],
  ["EngineeringManager", engineeringManagerAbbreviation],
];

export const classifyRole = (title: string): Option.Option<RoleLevelValue> => {
  if (excludedFunction.test(title) || nonEngineeringLeadership.test(title)) {
    return Option.none();
  }

  for (const [level, pattern] of rolePatterns) {
    if (pattern.test(title)) {
      return Option.some(level);
    }
  }

  return Option.none();
};

export const roleWeight = Match.type<RoleLevelValue>().pipe(
  Match.when("VicePresident", () => 40),
  Match.when("HeadOfEngineering", () => 38),
  Match.when("Director", () => 36),
  Match.when("EngineeringManager", () => 30),
  Match.exhaustive
);

const seniorityPatterns: readonly (readonly [SeniorityValue, RegExp])[] = [
  ["VicePresident", /\b(?:[sea]?vp|vice[\s-]+president)\b/iu],
  [
    "Executive",
    /\b(?:chief(?!\s+of\s+staff)|president|ceo|cto|coo|cio|ciso|cfo)\b/iu,
  ],
  ["SeniorDirector", /\b(?:senior|sr\.?)\s+(?:[a-z]+\s+){0,2}directors?\b/iu],
  ["Director", /\bdirectors?\b/iu],
  ["SeniorManager", /\b(?:senior|sr\.?)\s+(?:[a-z]+\s+){0,2}managers?\b/iu],
  ["Manager", /\bmanagers?\b/iu],
];

const someoneElse = /\b(?:to|of|for)\s+the\s+[^,|()–—-]*/giu;

export const seniorityOfTitle = (
  title: string
): Option.Option<SeniorityValue> => {
  const ownTitle = title.replaceAll(someoneElse, " ");

  return pipe(
    seniorityPatterns,
    Array.findFirst(([, pattern]) => pattern.test(ownTitle)),
    Option.map(([level]) => level)
  );
};

const headOf = /\bhead\s+of\b/iu;

const headOfLevels: ReadonlySet<SeniorityValue | null> = new Set([
  "Director",
  "VicePresident",
]);

export const seniorityOf = (
  title: string,
  answered: SeniorityValue | null
): SeniorityValue | null =>
  Option.getOrElse(seniorityOfTitle(title), () => {
    if (!headOf.test(title.replaceAll(someoneElse, " "))) {
      return null;
    }

    return headOfLevels.has(answered) ? answered : "Director";
  });
