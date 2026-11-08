import { Array, Match, Option, pipe } from "effect";

import type { RoleLevelValue, SeniorityValue } from "./job.js";

const engineeringScope =
  "(?:engineering|software|platform|infrastructure|(?:software|application|systems?) development|technology|data (?:engineering|platform|infrastructure)|machine learning|ml|ai|security|devops|sre|site reliability|backend|frontend|mobile|cloud)";

const excludedFunction =
  /\b(?:sales|solutions?|support(?!\s+(?:experience|platform|tool(?:ing|s)))|intern(?:ship)?|success|pre-?sales|professional services|managed services|implementation|consulting|account management|(?:executive|administrative|personal) assistants?)\b/iu;

const nonTeamFunction =
  /\b(?:support|customers?|accounts?|recruit\w*|talent|marketing|partners?|partnerships?|program|project|product manager|products? marketing|enablement|finance|legal|people|investment banking|business (?:development|director)|engagement managers?|general managers?|subject matter|counsel|workforce development)\b/iu;

const operationalFunction =
  /\b(?:facilities|field|project (?:engineering|management|managers?)|asset management|sourcing|vendor management|program manag\w*|tpm|operations managers?|account executives?)\b/iu;

const physicalFunction =
  /\b(?:civil|substation|welding|scada|hv cable|(?:structural|electrical|mechanical|geotechnical|power|pipeline|nuclear|transportation|process(?:\s+sustaining)?|industrial|manufacturing(?:\s+(?:equipment|controls))?)\s+engineering|fire protection|(?<!\b(?:video|data|network)\s+)transmission|power (?:plant|generation)|steam turbine|wastewater|maintenance\s*(?:&|and)\s*engineering|(?:fire|plant|construction|solar)\s+engineering|(?:data\s?center|site|corporate|global)\s+security\s+(?:managers?|operations))\b/iu;

const namesEngineeringWork = /\b(?:engineering|software)\b/iu;

const businessFunction =
  /\b(?:accounting|actuarial|audit|communications|compliance|delivery|design|events?|hr|managing directors?|policy managers?|research managers?|risk|sox|strategy)\b/iu;

const leadingEngineeringTitle =
  /^\s*(?:(?:senior|sr\.?|staff|principal|group)\s+)*(?:(?:software\s+)?engineering\s+manager(?:\s+i{1,3})?|manager,?\s+(?:software\s+)?engineering|directors?\s+of\s+(?:software\s+)?engineering|director,\s+(?:software\s+)?engineering)\s*[,(|:–—-]/iu;

const goToMarketEngineering =
  /\b(?:sales|solutions?|field|support|customer|pre-?sales|legal)\s+engineer(?:ing)?\b|\b(?:recruit\w*|talent)\b/iu;

const nonEngineeringLeadership =
  /^\s*(?:(?:senior|sr\.?|global|group|executive)\s+)*(?:directors?|managers?|s?vp|evp|vice[\s-]+president|head)\s*(?:of\s+|[,–—-]\s*)?(?:(?:(?:technology|technical|ai|software|platform)\s+)?products?\s+management\b|(?:products?|physical\s+security(?:\s*(?:&|and)\s+safety)?)(?=\s*(?:[,(|:/–—-]|$)|\s+(?:ai\s+)?growth\s*(?:[,(|:/–—-]|$)))/iu;

const productManagementLeadership =
  /^\s*(?:(?:senior|sr\.?|global|group|executive)\s+)*(?:(?:technology|technical|ai|software|platform)\s+)?products?\s+management\s+(?:directors?|managers?|s?vp|evp|vice[\s-]+president|head)\b/iu;

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

const techLeadManagerTitle = String.raw`(?:tech(?:nical)?\s+lead\s*\/?\s*managers?|tlm)`;

const techLeadManagerDenied = String.raw`(?:construction|clinical|nursing|structur(?:al|es)|mechanical|chemi(?:stry|cal)|tax|manufacturing|process engineering|trade lane|total loss|data scien\w*)`;

const techLeadManagerTeam = String.raw`(?:engineer\w*|software|swe|developers?|devops|sre|ml\w*|machine learning|ai|data|infrastructure|platforms?|cloud|security|backend|frontend|full[\s-]?stack|web|apps?|mobile|systems?|runtime|storage|gpu|tooling|connectors|technical staff|perception|autonomy|simulat\w*|motion planning|collision avoidance|multiverse|sensors?)`;

const softwareJargonLead = String.raw`tech\s+lead`;

const engineeringLadder = String.raw`(?:senior\s+)?(?:staff|principal)`;

const bareTechLeadManager = String.raw`(?:(?:senior|sr\.?)\s+)*${techLeadManagerTitle}\s*$`;

const techLeadManager = new RegExp(
  String.raw`^(?!.*\b${techLeadManagerDenied}\b)(?=.*\b(?:${softwareJargonLead}|${techLeadManagerTeam})\b|\s*${engineeringLadder}\b|\s*${bareTechLeadManager}).*\b${techLeadManagerTitle}\b`,
  "iu"
);

const managerDashScope =
  /^\s*(?:(?:senior|sr\.?|associate|principal)\s+)?managers?\s*[–—-]\s*(?:(?:[a-z&]+\s+){0,3}(?:engineering|software|sre|site reliability|devops|backend|frontend|platform)\b|(?:[a-z]+\s+){0,2}(?:infrastructure|security|ai|ml|machine learning|cloud)\s*(?:$|[(,|]))/iu;

const engineeringManagerAbbreviation =
  /^(?:(?:[Ss]enior|[Ss]r\.?)\s+)?EM(?:\s*[-,(]|\s*$)/u;

const rolePatterns: readonly (readonly [RoleLevelValue, RegExp])[] = [
  ["VicePresident", vicePresident],
  ["HeadOfEngineering", headOfEngineering],
  ["Director", director],
  ["EngineeringManager", engineeringManager],
  ["EngineeringManager", engineeringManagerAbbreviation],
  ["EngineeringManager", techLeadManager],
  ["EngineeringManager", managerDashScope],
];

export const classifyRole = (title: string): Option.Option<RoleLevelValue> => {
  const teamQualified =
    leadingEngineeringTitle.test(title) && !goToMarketEngineering.test(title);

  if (
    excludedFunction.test(title) ||
    (!teamQualified && nonTeamFunction.test(title)) ||
    operationalFunction.test(title) ||
    physicalFunction.test(title) ||
    (businessFunction.test(title) && !namesEngineeringWork.test(title)) ||
    nonEngineeringLeadership.test(title) ||
    productManagementLeadership.test(title)
  ) {
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
