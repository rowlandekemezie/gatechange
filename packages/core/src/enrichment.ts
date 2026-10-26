import {
  Array,
  Clock,
  Context,
  Data,
  Effect,
  Option,
  pipe,
  Predicate,
  Result,
  Schema,
} from "effect";

import { underBoardFacts } from "./board-facts.js";
import type { EnricherUnavailable } from "./enricher-unavailable.js";
import { EnrichmentQueue } from "./enrichment-queue.js";
import { JobStore } from "./job-store.js";
import {
  HandsOn,
  ListingDetails,
  RemotePolicy,
  SalaryBand,
  Seniority,
  SourceName,
} from "./job.js";
import type {
  ArrangementValue,
  EnrichmentValue,
  HandsOnValue,
  ListingDetailsValue,
  RemotePolicyValue,
  SalaryBandValue,
  SourceNameValue,
} from "./job.js";
import { PostingTexts } from "./posting-texts.js";
import { DAY_MILLIS } from "./posting.js";
import { seniorityOf } from "./role.js";
import { PROD_STAGE } from "./site.js";
import { SourceTerms } from "./source-terms.js";

export const MAX_POSTING_CHARS = 12_000;

export const MODEL_ANSWER_VERSION = 2;

export const ModelAnswer = Schema.Struct({
  handsOn: Schema.NullOr(HandsOn),
  handsOnQuote: Schema.NullOr(Schema.String),
  remotePolicy: Schema.NullOr(RemotePolicy),
  remotePolicyQuote: Schema.NullOr(Schema.String),
  reportsTo: Schema.NullOr(Schema.String),
  reportsToQuote: Schema.NullOr(Schema.String),
  salaryMax: Schema.NullOr(Schema.Finite),
  salaryMin: Schema.NullOr(Schema.Finite),
  seniority: Schema.NullOr(Seniority),
  teamSize: Schema.NullOr(Schema.Finite),
  teamSizeQuote: Schema.NullOr(Schema.String),
});

export type ModelAnswerValue = typeof ModelAnswer.Type;

const ReceivedAnswer = Schema.Struct({
  ...ModelAnswer.fields,
  handsOn: ModelAnswer.fields.handsOn.pipe(
    Schema.catchDecoding(() => Effect.succeedSome(null)),
    Schema.withDecodingDefault(Effect.succeed(null))
  ),
  handsOnQuote: ModelAnswer.fields.handsOnQuote.pipe(
    Schema.catchDecoding(() => Effect.succeedSome(null)),
    Schema.withDecodingDefault(Effect.succeed(null))
  ),
});

export interface PostingRequest {
  readonly company: string;
  readonly salary: SalaryBandValue | null;
  readonly salaryUncertain?: true;
  readonly text: string;
  readonly title: string;
  readonly workplace: ArrangementValue;
}

export interface ModelReply {
  readonly answer: unknown;
  readonly neurons: number | null;
}

export class ListingEnricher extends Context.Service<
  ListingEnricher,
  {
    readonly extract: (
      request: PostingRequest
    ) => Effect.Effect<ModelReply, EnricherUnavailable>;
    readonly maxNeurons: number;
    readonly minNeurons: number;
    readonly model: string;
    readonly neuronsFor: (request: PostingRequest) => number;
  }
>()("@rat-stack/core/ListingEnricher") {}

export const SkipReason = Schema.Literals([
  "Gone",
  "AlreadyEnriched",
  "Unsupported",
  "PostingUnavailable",
  "EmptyPosting",
  "ModelUnavailable",
  "Malformed",
  "DailyCapReached",
]);

export type SkipReasonValue = typeof SkipReason.Type;

export type SkipHandlingValue = "Acknowledge" | "Final" | "Retry";

export const skipHandling: Record<SkipReasonValue, SkipHandlingValue> = {
  AlreadyEnriched: "Acknowledge",
  DailyCapReached: "Retry",
  EmptyPosting: "Final",
  Gone: "Final",
  Malformed: "Final",
  ModelUnavailable: "Retry",
  PostingUnavailable: "Retry",
  Unsupported: "Acknowledge",
};

export const finalSkips: readonly SkipReasonValue[] = pipe(
  SkipReason.literals,
  Array.filter((reason) => skipHandling[reason] === "Final")
);

export type EnrichmentOutcomeValue = Data.TaggedEnum<{
  Enriched: { readonly enrichment: EnrichmentValue; readonly id: string };
  Skipped: {
    readonly detail: string;
    readonly id: string;
    readonly reason: SkipReasonValue;
  };
}>;

export const EnrichmentOutcome = Data.taggedEnum<EnrichmentOutcomeValue>();

export const enrichableSources: readonly SourceNameValue[] = pipe(
  SourceName.literals,
  Array.filter((source) => SourceTerms[source].kind === "CompanyBoard")
);

export const SalaryPeriod = Schema.Literals(["Year", "Month", "Hour"]);

export type SalaryPeriodValue = typeof SalaryPeriod.Type;

const periodFactor: Record<SalaryPeriodValue, number> = {
  Hour: 2080,
  Month: 12,
  Year: 1,
};

const populationWord = String.raw`(?:interns?|internships?|apprentices?|apprenticeships?|contractors?|contracts?|students?|co-?ops?)`;

const populationInTitle = new RegExp(String.raw`\b${populationWord}\b`, "iu");

export const annualSalaryBandOf = (
  { currency, max, min }: { currency: string; max: number; min: number },
  period: SalaryPeriodValue,
  title = ""
): SalaryBandValue | null =>
  period === "Hour" && populationInTitle.test(title)
    ? null
    : Option.getOrNull(
        Schema.decodeUnknownOption(SalaryBand)({
          currency,
          max: Math.round(max * periodFactor[period]),
          min: Math.round(min * periodFactor[period]),
        })
      );

export interface MoneyRange {
  readonly amounts: readonly number[];
  readonly currency: string;
  readonly period: SalaryPeriodValue;
}

const currencyCodes = [
  "USD",
  "CAD",
  "EUR",
  "GBP",
  "AUD",
  "NZD",
  "SGD",
  "HKD",
  "INR",
  "JPY",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "BRL",
  "MXN",
  "ILS",
  "ZAR",
];

const currencyMarker = String.raw`(?:[A-Z]{0,3}\$|£|€|₹|¥|\b(?:${currencyCodes.join("|")})\b)`;

const currencyMarkers = new RegExp(currencyMarker, "gu");

const markerRun = String.raw`(?:${currencyMarker}\s*){0,2}`;

const amountNamed = (name: string) =>
  String.raw`(?<${name}>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?<${name}K>\s?[kK](?![a-zA-Z]))?`;

const moneyPattern = new RegExp(
  String.raw`(?:(?<floor>\b(?:from|at least|minimum(?: of)?|starting at)\s+)|(?<ceiling>\b(?:up to|as much as|maximum(?: of)?)\s+))?(?<before>${markerRun})${amountNamed("low")}(?:\s*(?<middle>${markerRun})(?:[-‐-―−]|\bto\b|\band\b)\s*(?<between>${markerRun})${amountNamed("high")})?(?<after>(?:\s*${currencyMarker})?)`,
  "gu"
);

const symbolCurrency = new Map([
  ["$", "Dollar"],
  ["A$", "AUD"],
  ["C$", "CAD"],
  ["CA$", "CAD"],
  ["US$", "USD"],
  ["£", "GBP"],
  ["¥", "JPY"],
  ["€", "EUR"],
  ["₹", "INR"],
]);

const otherDollarCountry =
  /\b(?:canad(?:a|ian)|australian?|new zealand|singapore(?:an)?|hong kong|mexic(?:o|an))\b/iu;

const currencyOfMarkers = (
  markers: string,
  dollar: string | null
): string | null => {
  const named = pipe(
    [...markers.matchAll(currencyMarkers)],
    Array.map(([marker]) => symbolCurrency.get(marker) ?? marker),
    Array.dedupe
  );

  const explicit = pipe(
    named,
    Array.filter((name) => name !== "Dollar")
  );

  if (explicit.length > 1) {
    return "Mixed";
  }

  return explicit[0] ?? (named.length > 0 ? dollar : null);
};

const amountOf = (digits: string | undefined, thousands: string | undefined) =>
  Number((digits ?? "").replaceAll(",", "")) *
  (thousands === undefined ? 1 : 1000);

const LINE_CONTEXT_CHARS = 200;

interface Span {
  readonly end: number;
  readonly start: number;
}

interface LineAround {
  readonly after: string;
  readonly before: string;
}

const lineAround = (text: string, { end, start }: Span): LineAround => {
  const breakBefore = text.lastIndexOf("\n", start - 1);
  const breakAfter = text.indexOf("\n", end);

  const from = Math.max(breakBefore + 1, start - LINE_CONTEXT_CHARS);

  const to = Math.min(
    breakAfter === -1 ? text.length : breakAfter,
    end + LINE_CONTEXT_CHARS
  );

  return {
    after: text.slice(end, to),
    before: text.slice(from, start),
  };
};

const periodCue =
  /(?<Hour>(?:\bper\s+|\ban\s+|\/\s*)(?:hour|hr)\b|\bhourly\b)|(?<Month>(?:\bper\s+|\ba\s+|\/\s*)(?:month|mo)\b|\bmonthly\b)|(?<Year>(?:\bper\s+(?:1\s+)?|\ba\s+|\/\s*)(?:year|yr|annum)\b|\bannual(?:ly)?\b|\byearly\b)/giu;

const periodOfCue = (cue: RegExpMatchArray) =>
  SalaryPeriod.literals.find((period) => cue.groups?.[period] !== undefined);

const periodAround = (text: string, span: Span): SalaryPeriodValue => {
  const { after, before } = lineAround(text, span);

  return (
    pipe(
      Array.head([...after.matchAll(periodCue)]),
      Option.flatMap((cue) => Option.fromNullishOr(periodOfCue(cue))),
      Option.getOrUndefined
    ) ??
    pipe(
      Array.last([...before.matchAll(periodCue)]),
      Option.flatMap((cue) => Option.fromNullishOr(periodOfCue(cue))),
      Option.getOrUndefined
    ) ??
    "Year"
  );
};

interface MoneyMatch extends Span {
  readonly range: MoneyRange;
  readonly unroundedAmounts: readonly number[];
}

const moneyMatchesIn = (text: string): readonly MoneyMatch[] => {
  const dollar = otherDollarCountry.test(text) ? null : "USD";

  return Array.filterMap([...text.matchAll(moneyPattern)], (match) => {
    const groups = match.groups ?? {};

    const currency = currencyOfMarkers(
      [groups.before, groups.middle, groups.between, groups.after].join(" "),
      dollar
    );

    const oneEnded = groups.floor !== undefined || groups.ceiling !== undefined;

    if (currency === null || (oneEnded && groups.high === undefined)) {
      return Result.failVoid;
    }

    const span = { end: match.index + match[0].length, start: match.index };

    const unroundedAmounts = [
      amountOf(groups.low, groups.lowK),
      ...(groups.high === undefined
        ? []
        : [amountOf(groups.high, groups.highK)]),
    ];

    return Result.succeed({
      ...span,
      range: {
        amounts: unroundedAmounts.map(Math.round),
        currency,
        period: periodAround(text, span),
      },
      unroundedAmounts,
    });
  });
};

export const moneyRangesIn = (text: string): readonly MoneyRange[] =>
  Array.map(moneyMatchesIn(text), ({ range }) => range);

const basePayWord = String.raw`(?:salary|salaries|base|compensation|pay|wages?|remuneration)`;

const payNegation = String.raw`\b(?:not(?:\s+(?:counted|included|part))?(?:\s+(?:as|in|of))?|separate\s+from|in\s+addition\s+to|on\s+top\s+of|excluding|outside(?:\s+of)?)\s+(?:(?:the|your|our|any)\s+)?`;

const variablePayWord = String.raw`(?:ote|on[\s-]target|commissions?)`;

const otherPayWord = String.raw`(?:stipends?|bonus(?:es)?|${variablePayWord}|rsus?|allowances?|401\s?\(?k\)?|signing|sign-on|relocation|reimburse\w*)`;

const loosePayWord = String.raw`(?:incentives?|variable|stock|options?|equity|budgets?)`;

const moneyWord = String.raw`(?:${basePayWord}|${otherPayWord}|${loosePayWord}|grants?|plans?|targets?|awards?|units|cash)`;

const payJoiner = String.raw`(?:-based)?[\s/-]+`;

const totalWord = String.raw`(?:total|target(?:ed)?)`;

const totalHeading = new RegExp(
  String.raw`^\W*(?:[\p{L}-]+\s+){0,2}?${totalWord}\s+(?:${totalWord}\s+)?(?:cash|compensation)(?:\s+[\p{L}-]+){0,2}\W*$`,
  "iu"
);

const totalCash = new RegExp(
  String.raw`\b${totalWord}\s+(?:${totalWord}\s+)?cash\b`,
  "iu"
);

const otherPayInContext = String.raw`\b(?:${otherPayWord}|(?<=\breceives?\s+)${loosePayWord}|${loosePayWord}(?=${payJoiner}${moneyWord}\b))\b`;

const basePayCue = new RegExp(
  String.raw`(?<!${payNegation}(?:base\s+)?)(?<!\b(?:${otherPayWord}|${loosePayWord})${payJoiner}(?:targets?\s+)?)\b${basePayWord}\b`,
  "giu"
);

const otherPayCue = String.raw`(?:(?<!${payNegation})${otherPayInContext}|${payNegation}(?=(?:base\s+)?${basePayWord}\b))`;

const otherPayCues = new RegExp(otherPayCue, "giu");

const looseLabel = new RegExp(
  String.raw`^\W*${loosePayWord}(?:\W+${loosePayWord})*\W*$`,
  "iu"
);

const otherPopulation = new RegExp(
  String.raw`\b(?:(?:for|our)\s+(?:the\s+)?${populationWord}\b|${populationWord}(?=[\s(]+(?:applicants?|candidates?|roles?|positions?|rates?|program|pay|salary|salaries|wages?|compensation|hourly|only)\b))|^\W*${populationWord}\W*$`,
  "iu"
);

const otherPayNext = new RegExp(
  String.raw`^[\s•·*,:;–—-]*(?!(?:plus|and|with|or)\b)(?:[\p{L}-]+\s+){0,2}?${otherPayCue}`,
  "iu"
);

const lastIndexOf = (pattern: RegExp, text: string) =>
  pipe(
    Array.last([...text.matchAll(pattern)]),
    Option.map((match) => match.index),
    Option.getOrElse(() => -1)
  );

const namesPay = (line: string) =>
  lastIndexOf(basePayCue, line) !== -1 ||
  lastIndexOf(otherPayCues, line) !== -1;

const namesBasePay = (label: string) =>
  lastIndexOf(basePayCue, label) !== -1 &&
  lastIndexOf(otherPayCues, label) <= lastIndexOf(basePayCue, label);

const variablePay = new RegExp(String.raw`\b${variablePayWord}\b`, "iu");

export const namesVariablePay = (label: string) =>
  variablePay.test(label) && !namesBasePay(label);

const asideOtherPayWord = String.raw`(?:${variablePayWord}|(?:stock|equity)\s+grants?|bonus(?:es)?)`;

const asideOtherPay = new RegExp(String.raw`\b${asideOtherPayWord}\b`, "iu");

const asideNegation = new RegExp(
  String.raw`^\W*(?:and\b|with\b|or\b|\+)|\b(?:not|no(?=\s+${asideOtherPayWord})|pre(?=-${asideOtherPayWord})|excl|excluding|exclude[sd]?|exclusive|w/o|without|separate(?:ly)?|elsewhere|plus|before|on\s+top|in\s+addition|(?:if|where)\s+(?:applicable|eligible))\b|\b(?:bonus(?:es)?|commissions?)\s+(?:eligible|var(?:y|ies))\b`,
  "iu"
);

const namesOtherPayAside = (aside: string) =>
  asideOtherPay.test(aside) && !asideNegation.test(aside);

const withoutAsides = (text: string) =>
  text.replaceAll(/\([^()]*\)/gu, (aside) =>
    namesOtherPayAside(aside) ? ` ${aside.slice(1, -1)} ` : " "
  );

const rangeWords = new RegExp(
  String.raw`${currencyMarker}|${periodCue.source}`,
  "giu"
);

const rangeOnly = (text: string) =>
  /^[\s/(),:]*$/u.test(text.replaceAll(rangeWords, " "));

const carriesRange = (line: string) =>
  [...line.matchAll(moneyPattern)].some(
    ({ groups = {} }) =>
      groups.high !== undefined &&
      currencyOfMarkers(
        [groups.before, groups.middle, groups.between, groups.after].join(" "),
        "USD"
      ) !== null
  );

const MAX_UNLABELLED_LINES_ABOVE = 2;

const LABEL_WINDOW_CHARS = 2000;

type LineKind = "Blank" | "BareRow" | "SiblingRow" | "Label" | "Plain";

interface JudgedLine {
  readonly kind: LineKind;
  readonly label: string;
}

const judgedLineOf = (raw: string): JudgedLine => {
  const line = withoutAsides(raw.slice(-LINE_CONTEXT_CHARS));

  if (line.trim() === "") {
    return { kind: "Blank", label: "" };
  }

  if (carriesRange(line)) {
    const label = line.replaceAll(moneyPattern, " ");

    return { kind: rangeOnly(label) ? "BareRow" : "SiblingRow", label };
  }

  if (totalHeading.test(line) || totalCash.test(raw)) {
    return { kind: "Label", label: "" };
  }

  const labels =
    namesPay(line) ||
    looseLabel.test(line) ||
    otherPopulation.test(line) ||
    line.trimEnd().endsWith(":");

  return { kind: labels ? "Label" : "Plain", label: line };
};

interface PostingLines {
  readonly judgedByStart: Map<number, JudgedLine>;
  readonly text: string;
}

const judgedLineAt = (
  { judgedByStart, text }: PostingLines,
  start: number,
  end: number
) => {
  const known = judgedByStart.get(start);

  if (known !== undefined) {
    return known;
  }

  const judged = judgedLineOf(text.slice(start, end));

  judgedByStart.set(start, judged);

  return judged;
};

const labelAbove = (
  lines: PostingLines,
  { start }: Span,
  rangeAlone: boolean
) => {
  const { text } = lines;
  let unlabelled = 0;
  let nearestRow: string | undefined;
  let room = LABEL_WINDOW_CHARS;
  let end = text.lastIndexOf("\n", start - 1);

  while (end >= 0 && room > 0) {
    const from = end === 0 ? 0 : text.lastIndexOf("\n", end - 1) + 1;
    const length = end - from;

    const { kind, label } =
      length <= room
        ? judgedLineAt(lines, from, end)
        : judgedLineOf(text.slice(end - room, end));

    room -= length + 1;
    end = from - 1;

    if (kind === "Label" || (kind === "Plain" && !rangeAlone)) {
      return label;
    }

    if (kind === "SiblingRow" && rangeAlone) {
      return unlabelled === 0 ? label : "";
    }

    if (kind === "Plain") {
      unlabelled += 1;

      if (unlabelled > MAX_UNLABELLED_LINES_ABOVE) {
        return "";
      }
    }

    if (kind === "SiblingRow" || kind === "BareRow") {
      nearestRow ??= label;
    }
  }

  return nearestRow ?? "";
};

const zoneRow = /^\W*Zone\s+\d+\b/iu;

const zoneHeading =
  /\b(?:geographic\s+)?pay\s+zones?\b|\bgeographic\s+zones?\b/iu;

const inclusiveBonus =
  /\b(?:inclusive\s+of|including|includes?)\b[^.\n]*\b(?:bonus|ote|on[\s-]target)\b/iu;

const zoneFootnoteIncludesOtherPay = (
  text: string,
  span: Span,
  end: number
) => {
  const below = text
    .slice(end === -1 ? text.length : end + 1, span.end + LABEL_WINDOW_CHARS)
    .split("\n");

  for (const raw of below) {
    if (raw.trim() === "" || (zoneRow.test(raw) && carriesRange(raw))) {
      continue;
    }

    if (inclusiveBonus.test(raw) && !asideNegation.test(raw)) {
      return true;
    }

    break;
  }

  return false;
};

const zoneIncludesOtherPay = (text: string, span: Span) => {
  const from = text.lastIndexOf("\n", span.start - 1) + 1;
  const end = text.indexOf("\n", span.end);

  if (!zoneRow.test(text.slice(from, span.start))) {
    return false;
  }

  if (zoneFootnoteIncludesOtherPay(text, span, end)) {
    return true;
  }

  const above = text
    .slice(Math.max(0, from - LABEL_WINDOW_CHARS), from)
    .split("\n")
    .toReversed();

  let heading = false;
  let bridge = 0;

  for (const raw of above) {
    if (raw.trim() === "" || (zoneRow.test(raw) && carriesRange(raw))) {
      continue;
    }

    const variable = variablePay.exec(raw);

    if (
      heading &&
      variable !== null &&
      !asideNegation.test(raw.slice(0, variable.index))
    ) {
      return true;
    }

    if (namesBasePay(raw) && /\bbase\b/iu.test(raw)) {
      return false;
    }

    if (zoneHeading.test(raw)) {
      heading = true;
    } else if (
      !heading ||
      carriesRange(raw) ||
      bridge >= MAX_UNLABELLED_LINES_ABOVE
    ) {
      return false;
    } else {
      bridge += 1;
    }
  }

  return false;
};

const isBasePay = (lines: PostingLines, span: Span, title: string) => {
  const { text } = lines;
  const around = lineAround(text, span);
  const before = withoutAsides(around.before);
  const after = withoutAsides(around.after);
  const line = `${before} ${after}`;

  const forOtherPopulation = (label: string) =>
    otherPopulation.test(label) && !populationInTitle.test(title);

  if (
    forOtherPopulation(before) ||
    totalHeading.test(before) ||
    zoneIncludesOtherPay(text, span)
  ) {
    return false;
  }

  const rangeAlone = rangeOnly(line);

  if (rangeAlone || !namesPay(line)) {
    const label = labelAbove(lines, span, rangeAlone);

    return namesBasePay(label) && !forOtherPopulation(label);
  }

  return (
    lastIndexOf(basePayCue, line) !== -1 &&
    lastIndexOf(otherPayCues, before) <= lastIndexOf(basePayCue, before) &&
    !otherPayNext.test(after) &&
    !/^\s*(?:total\s+cash|equity\s+value)\b/iu.test(after)
  );
};

const statesBand = (stated: readonly number[], amounts: readonly number[]) =>
  Math.min(...stated) === Math.min(...amounts) &&
  Math.max(...stated) === Math.max(...amounts);

const salaryBandOf = (
  answer: ModelAnswerValue,
  { text, title }: PostingRequest
): SalaryBandValue | null => {
  const { salaryMax, salaryMin } = answer;

  if (salaryMin === null || salaryMax === null) {
    return null;
  }

  const stated = [salaryMin, salaryMax];
  const lines: PostingLines = { judgedByStart: new Map(), text };

  return pipe(
    moneyMatchesIn(text),
    Array.findFirst((match) =>
      statesBand(stated, match.range.amounts) && isBasePay(lines, match, title)
        ? Option.fromNullishOr(
            annualSalaryBandOf(
              {
                currency: match.range.currency,
                max: Math.max(...stated),
                min: Math.min(...stated),
              },
              match.range.period
            )
          )
        : Option.none()
    ),
    Option.getOrNull
  );
};

export const salaryDisagreesWithText = (
  salary: SalaryBandValue,
  rawText: string,
  title: string
) => {
  const text = rawText.trim().slice(0, MAX_POSTING_CHARS);
  const lines: PostingLines = { judgedByStart: new Map(), text };

  const bands = moneyMatchesIn(text).flatMap((match) => {
    if (match.range.amounts.length !== 2 || !isBasePay(lines, match, title)) {
      return [];
    }

    const band = annualSalaryBandOf(
      {
        currency: match.range.currency,
        max: Math.max(...match.unroundedAmounts),
        min: Math.min(...match.unroundedAmounts),
      },
      match.range.period,
      title
    );

    return band === null ? [] : [band];
  });

  return (
    bands.length > 0 &&
    !bands.some(
      (band) =>
        band.currency === salary.currency &&
        band.min === salary.min &&
        band.max === salary.max
    )
  );
};

const decodeReportsTo = Schema.decodeUnknownOption(
  ListingDetails.fields.reportsTo
);

const decodeTeamSize = Schema.decodeUnknownOption(
  ListingDetails.fields.teamSize
);

const pastExperience =
  /\b(?:\d+\+?\s*(?:years?|yrs)|experience\s+(?:leading|managing|building|running|with|of)|track record|proven|previously|have (?:led|managed))\b/iu;

const negationOf = (claim: RegExp) =>
  new RegExp(
    String.raw`\b(?:not|never|no|non)\b[\s-]+(?:[\w'’]+[\s-]+){0,3}?(?:${claim.source})|(?:${claim.source})[\s-]+(?:[\w'’]+[\s-]+){0,3}?(?:not|never|(?:is|are|ca|wo|do|does)n['’]t|cannot)\b`,
    "iu"
  );

const MIN_QUOTED_WORDS = 3;

const MAX_QUOTED_WORDS = 40;

const SENTENCE_CONTEXT_CHARS = 200;

interface SearchableText {
  readonly flat: string;
  readonly lines: string;
}

const foldText = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[–—]/gu, "-");

const searchableOf = (text: string): SearchableText => {
  const lines = foldText(text).replaceAll(/\s+/gu, (space) =>
    space.includes("\n") ? "\n" : " "
  );

  return { flat: lines.replaceAll("\n", " "), lines };
};

const sentenceBreaks: ReadonlySet<string> = new Set(["\n", ".", "!", "?", ";"]);

const sentenceAround = (lines: string, { end, start }: Span) => {
  const floor = Math.max(0, start - SENTENCE_CONTEXT_CHARS);
  const ceiling = Math.min(lines.length, end + SENTENCE_CONTEXT_CHARS);
  let from = start;
  let to = end;

  while (from > floor && !sentenceBreaks.has(lines.charAt(from - 1))) {
    from -= 1;
  }

  while (to < ceiling && !sentenceBreaks.has(lines.charAt(to))) {
    to += 1;
  }

  return lines.slice(from, to);
};

interface QuotedSentence {
  readonly quoted: string;
  readonly sentence: string;
}

const locatedQuote = (
  posting: SearchableText,
  quote: string | null,
  claim: RegExp
): Option.Option<QuotedSentence> => {
  const words = (quote ?? "")
    .split(/\s+/u)
    .filter((word) => word !== "")
    .slice(-MAX_QUOTED_WORDS);

  return pipe(
    Array.range(0, Math.max(0, words.length - MIN_QUOTED_WORDS)),
    Array.map((start) => words.slice(start)),
    Array.filter((kept) => kept.length > 0 && claim.test(kept.join(" "))),
    Array.findFirst((kept) => {
      const quoted = foldText(kept.join(" "));
      const start = posting.flat.indexOf(quoted);

      return start === -1
        ? Option.none()
        : Option.some({
            quoted,
            sentence: sentenceAround(posting.lines, {
              end: start + quoted.length,
              start,
            }),
          });
    })
  );
};

const quotedSentence = (
  posting: SearchableText,
  quote: string | null,
  claim: RegExp
) =>
  Option.filter(
    locatedQuote(posting, quote, claim),
    ({ sentence }) =>
      !pastExperience.test(sentence) && !negationOf(claim).test(sentence)
  );

const plainNegation = (sentence: string) =>
  sentence.replaceAll(
    /\b(?:do|does|is|are|ca|wo|would|should|could)n['’]t\b|\bcannot\b/giu,
    "not"
  );

const codingWork =
  /\b(?:hands[\s-]on|cod(?:e|es|ing)|programming|individual contributor|pull requests?)\b/iu;

const codingRequirement =
  /\b(?:experience\s+(?:writing|in|with|coding|programming)|(?:coding|programming|engineering|technical)\s+(?:skills?|abilit(?:y|ies)|background|experience)|proficien(?:cy|t)\s+(?:in|with|at)|background\s+in)\b/iu;

const handsOnOf = (
  answer: ModelAnswerValue,
  posting: SearchableText
): HandsOnValue | null =>
  pipe(
    Option.fromNullishOr(answer.handsOn),
    Option.filter((claimed) =>
      pipe(
        locatedQuote(posting, answer.handsOnQuote, codingWork),
        Option.exists(
          ({ sentence }) =>
            !pastExperience.test(sentence) &&
            !codingRequirement.test(sentence) &&
            negationOf(codingWork).test(plainNegation(sentence)) ===
              (claimed === "None")
        )
      )
    ),
    Option.getOrNull
  );

const peopleCount = (size: number) =>
  new RegExp(
    String.raw`(?:\b${size}\+?\s+(?:[a-z-]+\s+){0,2}(?:people|persons?|engineers|developers|scientists|analysts|designers|managers|leads|members|reports|individuals|employees|staff|sdets|ics)\b|\bteam of (?:about |approximately |around |roughly |~)?${size}\b|\bdirect reports?:?\s*${size}\b)`,
    "iu"
  );

const leadsTeam =
  /\b(?:lead|leads|leading|manage|manages|managing|oversee|oversees|overseeing|run|runs|running|head|heads)\b/iu;

const directReports = /\breports?\b/iu;

const ownTeam = /\byour\s+(?:[\p{L}-]+\s+)?$/u;

const futureSize =
  /\b(?:grows?|growing|scal(?:e|es|ing)|expands?|expanding|doubl(?:e|es|ing))\s+(?:[\p{L}-]+\s+){0,2}?(?:to|into)\s+(?:about\s+|around\s+|over\s+|~)?$/u;

const teamSizeOf = (answer: ModelAnswerValue, posting: SearchableText) => {
  if (answer.teamSize === null) {
    return null;
  }

  const size = Math.round(answer.teamSize);
  const counted = peopleCount(size);

  return pipe(
    quotedSentence(posting, answer.teamSizeQuote, counted),
    Option.filter(({ sentence }) =>
      pipe(
        Option.fromNullishOr(counted.exec(sentence)),
        Option.exists((count) => {
          const before = sentence.slice(0, count.index);

          return (
            !futureSize.test(before) &&
            (directReports.test(count[0]) ||
              leadsTeam.test(before) ||
              ownTeam.test(before))
          );
        })
      )
    ),
    Option.flatMap(() => decodeTeamSize(size)),
    Option.getOrNull
  );
};

const notWorkplace = String.raw`(?![\s-]+(?:interviews?|meetings?|events?|offsites?|onsites?|visits?|gatherings?|meetups?|onboarding|training|summits?|retreats?)\b)`;

const describesTheRole = (word: string, roleWords: string) =>
  String.raw`\b${word}\b(?=$|\s*[^\p{L}\p{N}\s-]|\s*-\s|\s+(?:${roleWords})\b)`;

const roleRemote = new RegExp(
  String.raw`${describesTheRole("remote", "roles?|positions?|jobs?|opportunit(?:y|ies)|work(?:ing)?|basis|options?|eligible|in|within|from|across|anywhere|only|or|and|for|with|us|usa|uk|eu|emea|apac|latam|canada|europe|worldwide|globally")}|\bwork(?:ing)? remotely\b|\bwork from (?:home|anywhere)\b`,
  "iu"
);

const companyRemote = /\bremote-(?:first|friendly)\b/iu;

const remoteWork = new RegExp(
  `${roleRemote.source}|${companyRemote.source}`,
  "iu"
);

const roleSubject = /\b(?:you|your|role|position|job|candidate)\b/u;

const onsiteWork = describesTheRole(
  "on-?site",
  "roles?|positions?|jobs?|work(?:ing)?|full[- ]time|every|five|5|in|at|from|only|basis|presence|requirement|and|or|with|for"
);

const officeAttendance = String.raw`\b(?:offices?|on-?site|in[- ]person|hq|headquarters|campus)\b${notWorkplace}`;

const attendanceTiming = String.raw`\bdays? (?:a|per|each) week\b|\b(?:mon|tues|wednes|thurs|fri)days?\b|\b\d+% of the time\b`;

const remotePolicyCues: Record<RemotePolicyValue, RegExp> = {
  Hybrid: new RegExp(
    String.raw`\bhybrid\b|${officeAttendance}[^.\n]*(?:${attendanceTiming})|(?:${attendanceTiming})[^.\n]*${officeAttendance}`,
    "iu"
  ),
  Onsite: new RegExp(
    String.raw`${onsiteWork}|(?:\bin[- ](?:the )?office\b|\bin[- ]person\b)${notWorkplace}|\b5 days (?:a|per) week\b`,
    "iu"
  ),
  Remote: remoteWork,
  RemoteInRegion: remoteWork,
};

const occasionalVisits =
  /\btimes?\s*(?:a|per|\/)\s*(?:month|quarter|year)\b|\b(?:monthly|quarterly|occasional(?:ly)?)\b/iu;

const officeShare =
  /\bhybrid (?:work(?:ing)? )?policy\b|\boffices?\b[^.\n]{0,40}\b\d{1,2}% of the time\b/iu;

const statesOfficeShare = (posting: SearchableText) =>
  Array.some(
    posting.lines.split(/[\n.!?;]/u),
    (sentence) =>
      officeShare.test(sentence) && !negationOf(officeShare).test(sentence)
  );

const workplaceTags: readonly (readonly [RemotePolicyValue, RegExp])[] = [
  ["Remote", /#LI-Remote\b/iu],
  ["Hybrid", /#LI-Hybrid\b/iu],
  ["Onsite", /#LI-On-?site\b/iu],
];

const policyStatements: Record<RemotePolicyValue, RegExp> = {
  Hybrid: remotePolicyCues.Hybrid,
  Onsite: new RegExp(
    String.raw`${onsiteWork}|\b(?:5|five) days (?:a|per) week\b`,
    "iu"
  ),
  Remote: roleRemote,
  RemoteInRegion: roleRemote,
};

const roleStatesOtherPolicy = (
  posting: SearchableText,
  claimed: RemotePolicyValue
) =>
  Array.some(
    posting.lines.split(/[\n.!?;]/u),
    (sentence) =>
      roleSubject.test(sentence) &&
      !remotePolicyCues[claimed].test(sentence) &&
      RemotePolicy.literals.some(
        (policy) =>
          policyStatements[policy] !== policyStatements[claimed] &&
          policyStatements[policy].test(sentence)
      )
  );

const statedArrangement = (word: string) =>
  new RegExp(
    String.raw`\bwork(?:ing)? arrangement\s*:\s*${word}\b|\b${word} work(?:ing)? arrangement\b|\bthis is an? ${word} (?:role|position)\b`,
    "iu"
  );

const arrangementStatements: readonly (readonly [RemotePolicyValue, RegExp])[] =
  [
    ["Hybrid", statedArrangement("hybrid")],
    ["Remote", statedArrangement("remote")],
    ["Onsite", statedArrangement("on-?site")],
  ];

const arrangementStated = (posting: SearchableText) =>
  pipe(
    arrangementStatements,
    Array.findFirst(([, statement]) =>
      Array.some(
        posting.lines.split(/[\n.!?;]/u),
        (sentence) =>
          statement.test(sentence) &&
          !pastExperience.test(sentence) &&
          !/\bexperience\s+(?:working|in|under|within)\b/iu.test(sentence) &&
          !negationOf(statement).test(plainNegation(sentence))
      )
    ),
    Option.map(([stated]) => stated)
  );

const taggedPolicy = (posting: SearchableText) =>
  pipe(
    workplaceTags,
    Array.findFirst(([, tag]) => tag.test(posting.flat)),
    Option.map(([tagged]) => tagged),
    Option.filter((tagged) => !roleStatesOtherPolicy(posting, tagged))
  );

const quotedPolicy = (answer: ModelAnswerValue, posting: SearchableText) =>
  pipe(
    Option.fromNullishOr(answer.remotePolicy),
    Option.filter((claimed) =>
      pipe(
        quotedSentence(
          posting,
          answer.remotePolicyQuote,
          remotePolicyCues[claimed]
        ),
        Option.exists(({ quoted, sentence }) =>
          claimed === "Remote" || claimed === "RemoteInRegion"
            ? (roleRemote.test(quoted) && roleSubject.test(sentence)) ||
              !roleStatesOtherPolicy(posting, claimed)
            : !occasionalVisits.test(sentence)
        )
      )
    )
  );

const remotePolicyOf = (
  answer: ModelAnswerValue,
  posting: SearchableText,
  workplace: ArrangementValue
): RemotePolicyValue | null => {
  const quoted = quotedPolicy(answer, posting);

  return pipe(
    workplace === "Unspecified"
      ? Option.none()
      : Option.some(
          pipe(
            arrangementStated(posting),
            Option.orElse(() => taggedPolicy(posting)),
            Option.getOrElse((): RemotePolicyValue => workplace)
          )
        ),
    Option.map((stated) =>
      stated === "Remote" &&
      Option.exists(quoted, (policy) => policy === "RemoteInRegion")
        ? "RemoteInRegion"
        : stated
    ),
    Option.orElse(() => quoted),
    Option.orElse(() =>
      statesOfficeShare(posting)
        ? Option.some("Hybrid" as const)
        : Option.none()
    ),
    Option.orElse(() => taggedPolicy(posting)),
    Option.getOrNull
  );
};

const reportingLine =
  /\breport(?:s|ing)?\s+(?:directly\s+)?(?:in)?to\b|\breporting\s+line\b/iu;

const titleWords = (title: string) =>
  pipe(
    title.toLowerCase().split(/[^\p{L}\p{N}]+/u),
    Array.filter(
      (word) =>
        word !== "" && !["a", "an", "and", "of", "our", "the"].includes(word)
    )
  );

const auxiliaries: ReadonlySet<string> = new Set([
  "also",
  "are",
  "be",
  "currently",
  "d",
  "directly",
  "is",
  "ll",
  "shall",
  "will",
  "would",
]);

const roleSubjects: ReadonlySet<string> = new Set([
  "candidate",
  "hire",
  "incumbent",
  "individual",
  "job",
  "person",
  "position",
  "role",
  "you",
  "your",
]);

const clauseLinks: ReadonlySet<string> = new Set(["and", "or", "then", "to"]);

const relativePronouns: ReadonlySet<string> = new Set(["that", "which", "who"]);

const namesTheRole = (words: readonly string[], postingTitle: string) => {
  const title = titleWords(postingTitle);
  const named = titleWords(words.join(" ")).slice(-title.length);

  return (
    roleSubjects.has(words.at(-1) ?? "") ||
    (title.length > 0 && named.join(" ") === title.join(" "))
  );
};

const reportsAsRole = (sentence: string, postingTitle: string) => {
  const line = reportingLine.exec(sentence);

  if (line === null) {
    return false;
  }

  const isRole = (word: string) =>
    roleSubjects.has(word) || titleWords(postingTitle).includes(word);

  const words = pipe(
    sentence.slice(0, line.index).split(/[^\p{L}\p{N}]+/u),
    Array.filter((word) => word !== "" && !auxiliaries.has(word))
  );

  return Option.match(Array.last(words), {
    onNone: () => true,
    onSome: (subject) => {
      if (relativePronouns.has(subject)) {
        return namesTheRole(words.slice(0, -1), postingTitle);
      }

      return (
        isRole(subject) ||
        (clauseLinks.has(subject) && words.some((word) => isRole(word)))
      );
    },
  });
};

const titleWord =
  /\b(?:chief|c[a-z]o|vp|evp|svp|vice|president|director|head|manager|lead|leader|founder|co-founder|officer|principal|partner|gm|architect|engineer|owner|chair(?:man|woman|person)?|executive|supervisor|counsel)s?\b/iu;

const withoutNames = (said: string) => {
  const title = said
    .replaceAll(/\s*\((?<inner>[^)]*)\)/gu, (group, inner: string) =>
      titleWord.test(inner) ? group : ""
    )
    .replaceAll(/\s+/gu, " ")
    .trim();

  const leading =
    /^(?<first>[^,;]*?)(?:\s*[,;]\s*|\s[-–—]\s)(?<rest>.+)$/u.exec(
      title
    )?.groups;

  return leading !== undefined && !titleWord.test(leading.first ?? "")
    ? (leading.rest ?? "")
    : title;
};

const reportsToTitleOf = (said: string) => {
  const title = withoutNames(said);

  return titleWord.test(title)
    ? title.replace(/^(?:the|our|your|a|an)\s+/iu, "")
    : "";
};

const reportsToOf = (
  answer: ModelAnswerValue,
  posting: SearchableText,
  postingTitle: string
) => {
  const title = reportsToTitleOf(answer.reportsTo ?? "");

  return pipe(
    quotedSentence(posting, answer.reportsToQuote, reportingLine),
    Option.filter(({ quoted, sentence }) => {
      const said = new Set(titleWords(quoted));

      return (
        Array.every(titleWords(title), (word) => said.has(word)) &&
        reportsAsRole(sentence, postingTitle)
      );
    }),
    Option.flatMap(() => decodeReportsTo(title)),
    Option.getOrNull
  );
};

export const detailsOfAnswer = (
  answer: ModelAnswerValue,
  posting: PostingRequest
): ListingDetailsValue => {
  const searchable = searchableOf(posting.text);

  return {
    handsOn: handsOnOf(answer, searchable),
    remotePolicy: remotePolicyOf(answer, searchable, posting.workplace),
    reportsTo: reportsToOf(answer, searchable, posting.title),
    salary:
      posting.salaryUncertain === true
        ? null
        : (posting.salary ?? salaryBandOf(answer, posting)),
    seniority: seniorityOf(posting.title, answer.seniority),
    teamSize: teamSizeOf(answer, searchable),
  };
};

const HOUR_MILLIS = 3_600_000;

export const DEFAULT_ENRICHMENT_SWEEP_LIMIT = 8;

export const DEFAULT_DAILY_NEURONS = 29_000;

export const sweepLimitOf = (deploy: {
  readonly configured: Option.Option<number>;
  readonly stage: string;
}) =>
  Option.getOrElse(deploy.configured, () =>
    deploy.stage === PROD_STAGE ? DEFAULT_ENRICHMENT_SWEEP_LIMIT : 0
  );

export const enqueueUnenriched = Effect.fn("enqueueUnenriched")(
  function* enqueueUnenriched(sweep: {
    readonly limit: number;
    readonly now: number;
    readonly windowHours: number;
  }) {
    const store = yield* JobStore;
    const queue = yield* EnrichmentQueue;

    const ids = yield* store.unenrichedListings({
      finalSkips,
      limit: sweep.limit,
      promptVersion: MODEL_ANSWER_VERSION,
      since: sweep.now - sweep.windowHours * HOUR_MILLIS,
      sources: enrichableSources,
    });

    yield* queue.enqueue(ids);

    return ids.length;
  }
);

export const enrichListing = Effect.fn("enrichListing")(function* enrichListing(
  id: string,
  dailyNeurons: number = DEFAULT_DAILY_NEURONS
) {
  const store = yield* JobStore;
  const texts = yield* PostingTexts;
  const enricher = yield* ListingEnricher;
  const day = Math.floor((yield* Clock.currentTimeMillis) / DAY_MILLIS);

  const skip = (reason: SkipReasonValue, detail: string) =>
    EnrichmentOutcome.Skipped({ detail: detail.slice(0, 300), id, reason });

  const found = yield* store.findIncludingDeparted(id);

  if (Option.isNone(found)) {
    return skip("Gone", "the listing is no longer on the board");
  }

  const job = found.value;

  if (
    job.enrichment !== null &&
    job.enrichment.model !== null &&
    (job.enrichment.promptVersion ?? 1) >= MODEL_ANSWER_VERSION
  ) {
    return skip("AlreadyEnriched", `enriched at ${job.enrichment.enrichedAt}`);
  }

  if (!Array.contains(enrichableSources, job.source)) {
    return skip("Unsupported", `${job.source} is not a company board`);
  }

  const budgetSpent = () =>
    skip("DailyCapReached", `the ${dailyNeurons} neurons for today are spent`);

  const details = store.neuronsClaimed(day).pipe(
    Effect.filterOrFail(
      (claimed) => claimed + enricher.maxNeurons <= dailyNeurons,
      budgetSpent
    ),
    Effect.flatMap(() =>
      texts
        .fetch(job)
        .pipe(
          Effect.mapError((failure) =>
            skip(
              Predicate.isTagged(failure, "PostingGone")
                ? "Gone"
                : "PostingUnavailable",
              failure.message
            )
          )
        )
    ),
    Effect.map(
      ({ salary, salaryUncertain, text, workplace }): PostingRequest => {
        const posting = {
          company: job.company,
          salary,
          text: text.trim().slice(0, MAX_POSTING_CHARS),
          title: job.title,
          workplace,
        };

        return salaryUncertain === true
          ? { ...posting, salaryUncertain }
          : posting;
      }
    ),
    Effect.filterOrFail(
      (posting) => posting.text.length > 0,
      () => skip("EmptyPosting", "the posting has no text")
    ),
    Effect.flatMap((posting) =>
      store
        .claimNeurons({
          budget: dailyNeurons,
          day,
          neurons: enricher.neuronsFor(posting),
        })
        .pipe(
          Effect.filterOrFail((claimed) => claimed, budgetSpent),
          Effect.as(posting)
        )
    ),
    Effect.flatMap((posting) =>
      enricher.extract(posting).pipe(
        Effect.mapError((failure) => skip("ModelUnavailable", failure.message)),
        Effect.tap(({ neurons }) =>
          neurons === null ||
          !Number.isSafeInteger(neurons) ||
          neurons < enricher.minNeurons
            ? Effect.void
            : store.recordNeuronsUsed({
                claimed: enricher.neuronsFor(posting),
                day,
                neurons,
              })
        ),
        Effect.flatMap(({ answer }) =>
          Schema.decodeUnknownEffect(ReceivedAnswer)(answer).pipe(
            Effect.mapError((failure) => skip("Malformed", failure.message))
          )
        ),
        Effect.flatMap((answer) =>
          Effect.try({
            catch: () =>
              skip("Malformed", "the guards failed on the model answer"),
            try: () => detailsOfAnswer(answer, posting),
          })
        )
      )
    )
  );

  return yield* details.pipe(
    Effect.flatMap((listing) =>
      Effect.gen(function* saveListing() {
        const enrichment: EnrichmentValue = {
          ...underBoardFacts(job.enrichment, listing),
          board: job.enrichment?.board ?? null,
          enrichedAt: yield* Clock.currentTimeMillis,
          model: enricher.model,
          promptVersion: MODEL_ANSWER_VERSION,
        };

        yield* store.saveEnrichment(id, enrichment);

        return EnrichmentOutcome.Enriched({ enrichment, id });
      })
    ),
    Effect.catchTag("Skipped", (skipped) =>
      skipHandling[skipped.reason] === "Acknowledge"
        ? Effect.succeed(skipped)
        : Effect.gen(function* recordSkip() {
            yield* store.recordSkip(id, {
              reason: skipped.reason,
              skippedAt: yield* Clock.currentTimeMillis,
            });

            return skipped;
          })
    )
  );
});
