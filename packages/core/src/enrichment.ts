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

import type { EnricherUnavailable } from "./enricher-unavailable.js";
import { EnrichmentQueue } from "./enrichment-queue.js";
import { JobStore } from "./job-store.js";
import {
  ListingDetails,
  RemotePolicy,
  SalaryBand,
  Seniority,
  SourceName,
} from "./job.js";
import type {
  EnrichmentValue,
  ListingDetailsValue,
  RemotePolicyValue,
  SalaryBandValue,
  SourceNameValue,
} from "./job.js";
import { PostingTexts } from "./posting-texts.js";
import { DAY_MILLIS } from "./posting.js";
import { seniorityOf } from "./role.js";
import { SourceTerms } from "./source-terms.js";

export const MAX_POSTING_CHARS = 12_000;

export const ModelAnswer = Schema.Struct({
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

export interface PostingRequest {
  readonly company: string;
  readonly text: string;
  readonly title: string;
}

export class ListingEnricher extends Context.Service<
  ListingEnricher,
  {
    readonly extract: (
      request: PostingRequest
    ) => Effect.Effect<unknown, EnricherUnavailable>;
    readonly model: string;
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
  String.raw`(?:(?<floor>\b(?:from|at least|minimum(?: of)?|starting at)\s+)|(?<ceiling>\b(?:up to|as much as|maximum(?: of)?)\s+))?(?<before>${markerRun})${amountNamed("low")}(?:\s*(?<middle>${markerRun})(?:-|–|—|\bto\b|\band\b)\s*(?<between>${markerRun})${amountNamed("high")})?(?<after>(?:\s*${currencyMarker})?)`,
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
  Math.round(
    Number((digits ?? "").replaceAll(",", "")) *
      (thousands === undefined ? 1 : 1000)
  );

const LINE_CONTEXT_CHARS = 200;

interface Span {
  readonly end: number;
  readonly start: number;
}

interface LineAround {
  readonly after: string;
  readonly before: string;
  readonly line: string;
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
    line: text.slice(from, to),
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

    return Result.succeed({
      ...span,
      range: {
        amounts: [
          amountOf(groups.low, groups.lowK),
          ...(groups.high === undefined
            ? []
            : [amountOf(groups.high, groups.highK)]),
        ],
        currency,
        period: periodAround(text, span),
      },
    });
  });
};

export const moneyRangesIn = (text: string): readonly MoneyRange[] =>
  Array.map(moneyMatchesIn(text), ({ range }) => range);

const basePayCue =
  /\b(?:salary|salaries|base|compensation|pay|wages?|ote|remuneration|earnings)\b/giu;

const otherPayCue = String.raw`\b(?:stipends?|bonus(?:es)?|allowances?|equity|401\s?\(?k\)?|signing|sign-on|relocation|reimburse\w*|budgets?)\b`;

const otherPayCues = new RegExp(otherPayCue, "giu");

const otherPayNext = new RegExp(
  String.raw`^\s*(?!(?:plus|and|with|or)\b)(?:[\p{L}-]+\s+){0,2}?${otherPayCue}`,
  "iu"
);

const lastIndexOf = (pattern: RegExp, text: string) =>
  pipe(
    Array.last([...text.matchAll(pattern)]),
    Option.map((match) => match.index),
    Option.getOrElse(() => -1)
  );

const namesBasePay = (label: string) =>
  lastIndexOf(basePayCue, label) !== -1 &&
  lastIndexOf(otherPayCues, label) <= lastIndexOf(basePayCue, label);

const rangeOnly = new RegExp(
  String.raw`^(?:\s|${currencyMarker}|${periodCue.source}|[/(),:])*$`,
  "iu"
);

const headingAbove = (text: string, { start }: Span) => {
  const lineStart = text.lastIndexOf("\n", start - 1);

  return lineStart <= 0
    ? ""
    : lineAround(text, { end: lineStart, start: lineStart }).before;
};

const isBasePay = (text: string, span: Span) => {
  const { after, before, line } = lineAround(text, span);

  if (rangeOnly.test(`${before} ${after}`)) {
    return namesBasePay(headingAbove(text, span));
  }

  return (
    lastIndexOf(basePayCue, line) !== -1 &&
    lastIndexOf(otherPayCues, before) <= lastIndexOf(basePayCue, before) &&
    !otherPayNext.test(after)
  );
};

const statesBand = (stated: readonly number[], amounts: readonly number[]) =>
  Math.min(...stated) === Math.min(...amounts) &&
  Math.max(...stated) === Math.max(...amounts);

const salaryBandOf = (
  answer: ModelAnswerValue,
  text: string
): SalaryBandValue | null => {
  const { salaryMax, salaryMin } = answer;

  if (salaryMin === null || salaryMax === null) {
    return null;
  }

  const stated = [salaryMin, salaryMax];

  return pipe(
    moneyMatchesIn(text),
    Array.findFirst(
      (match) =>
        statesBand(stated, match.range.amounts) && isBasePay(text, match)
    ),
    Option.flatMap(({ range }) =>
      Schema.decodeUnknownOption(SalaryBand)({
        currency: range.currency,
        max: Math.round(Math.max(...stated) * periodFactor[range.period]),
        min: Math.round(Math.min(...stated) * periodFactor[range.period]),
      })
    ),
    Option.getOrNull
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

const quotedSentence = (
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
    }),
    Option.filter(
      ({ sentence }) =>
        !pastExperience.test(sentence) && !negationOf(claim).test(sentence)
    )
  );
};

const peopleCount = (size: number) =>
  new RegExp(
    String.raw`(?:\b${size}\+?\s+(?:[a-z-]+\s+){0,2}(?:people|persons?|engineers|developers|scientists|analysts|designers|managers|leads|members|reports|individuals|employees|staff|sdets|ics)\b|\bteam of (?:about |approximately |around |roughly |~)?${size}\b|\bdirect reports?:?\s*${size}\b)`,
    "iu"
  );

const leadsTeam =
  /\b(?:lead|leads|leading|manage|manages|managing|oversee|oversees|overseeing|run|runs|running|head|heads)\b/iu;

const directReports = /\breports?\b/iu;

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
        Option.exists(
          (count) =>
            directReports.test(count[0]) ||
            leadsTeam.test(sentence.slice(0, count.index))
        )
      )
    ),
    Option.flatMap(() => decodeTeamSize(size)),
    Option.getOrNull
  );
};

const notWorkplace = String.raw`(?![\s-]+(?:interviews?|meetings?|events?|offsites?|onsites?|visits?|gatherings?|meetups?|onboarding|training|summits?|retreats?)\b)`;

const remoteWork =
  /\bremote\b(?![\s-]+(?:teams?|employees|workers|colleagues|staff|collaboration|tools?|companies|interviews?|onboarding)\b)|\bwork from (?:home|anywhere)\b/iu;

const officeAttendance = String.raw`\b(?:offices?|on-?site|in[- ]person|hq|headquarters|campus)\b${notWorkplace}`;

const attendanceTiming = String.raw`\bdays? (?:a|per|each) week\b|\b(?:mon|tues|wednes|thurs|fri)days?\b|\b\d+% of the time\b`;

const remotePolicyCues: Record<RemotePolicyValue, RegExp> = {
  Hybrid: new RegExp(
    String.raw`\bhybrid\b|${officeAttendance}[^.\n]*(?:${attendanceTiming})|(?:${attendanceTiming})[^.\n]*${officeAttendance}`,
    "iu"
  ),
  Onsite: new RegExp(
    String.raw`(?:\bon-?site\b|\bin[- ](?:the )?office\b|\bin[- ]person\b)${notWorkplace}|\b5 days (?:a|per) week\b`,
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

const WORKPLACE_LINE = "workplace type:";

const workplaceTypes = new Map<string, RemotePolicyValue>([
  ["hybrid", "Hybrid"],
  ["inoffice", "Onsite"],
  ["inperson", "Onsite"],
  ["onsite", "Onsite"],
  ["remote", "Remote"],
]);

const statedWorkplace = (posting: SearchableText) =>
  pipe(
    posting.lines.split("\n"),
    Array.findLast((line) => line.startsWith(WORKPLACE_LINE)),
    Option.flatMapNullishOr((line) =>
      workplaceTypes.get(
        line.slice(WORKPLACE_LINE.length).replaceAll(/[\s_-]/gu, "")
      )
    )
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
        Option.exists(
          ({ sentence }) =>
            claimed === "Remote" ||
            claimed === "RemoteInRegion" ||
            !occasionalVisits.test(sentence)
        )
      )
    )
  );

const remotePolicyOf = (
  answer: ModelAnswerValue,
  posting: SearchableText
): RemotePolicyValue | null => {
  const quoted = quotedPolicy(answer, posting);

  return pipe(
    statedWorkplace(posting),
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
    Option.orElse(() =>
      pipe(
        workplaceTags,
        Array.findFirst(([, tag]) => tag.test(posting.flat)),
        Option.map(([tagged]) => tagged)
      )
    ),
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
  "currently",
  "d",
  "directly",
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

const clauseLinks: ReadonlySet<string> = new Set([
  "and",
  "or",
  "that",
  "then",
  "to",
  "which",
  "who",
]);

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
    onSome: (subject) =>
      isRole(subject) ||
      (clauseLinks.has(subject) && words.some((word) => isRole(word))),
  });
};

const reportsToOf = (
  answer: ModelAnswerValue,
  posting: SearchableText,
  postingTitle: string
) => {
  const title = answer.reportsTo?.replaceAll(/\s+/gu, " ").trim() ?? "";

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
    remotePolicy: remotePolicyOf(answer, searchable),
    reportsTo: reportsToOf(answer, searchable, posting.title),
    salary: salaryBandOf(answer, posting.text),
    seniority: seniorityOf(posting.title, answer.seniority),
    teamSize: teamSizeOf(answer, searchable),
  };
};

const HOUR_MILLIS = 3_600_000;

export const PROD_STAGE = "prod";

export const DEFAULT_ENRICHMENT_SWEEP_LIMIT = 8;

export const DEFAULT_DAILY_MODEL_CALLS = 576;

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
      since: sweep.now - sweep.windowHours * HOUR_MILLIS,
      sources: enrichableSources,
    });

    yield* queue.enqueue(ids);

    return ids.length;
  }
);

export const enrichListing = Effect.fn("enrichListing")(function* enrichListing(
  id: string,
  dailyModelCalls: number = DEFAULT_DAILY_MODEL_CALLS
) {
  const store = yield* JobStore;
  const texts = yield* PostingTexts;
  const enricher = yield* ListingEnricher;

  const skip = (reason: SkipReasonValue, detail: string) =>
    EnrichmentOutcome.Skipped({ detail: detail.slice(0, 300), id, reason });

  const found = yield* store.find(id);

  if (Option.isNone(found)) {
    return skip("Gone", "the listing is no longer on the board");
  }

  const job = found.value;

  if (job.enrichment !== null) {
    return skip("AlreadyEnriched", `enriched at ${job.enrichment.enrichedAt}`);
  }

  if (!Array.contains(enrichableSources, job.source)) {
    return skip("Unsupported", `${job.source} is not a company board`);
  }

  const claimModelCall = Effect.gen(function* claimModelCall() {
    const now = yield* Clock.currentTimeMillis;

    return yield* store.claimModelCall({
      day: Math.floor(now / DAY_MILLIS),
      limit: dailyModelCalls,
    });
  });

  const details = texts.fetch(job).pipe(
    Effect.mapError((failure) =>
      skip(
        Predicate.isTagged(failure, "PostingGone")
          ? "Gone"
          : "PostingUnavailable",
        failure.message
      )
    ),
    Effect.map((text) => text.trim().slice(0, MAX_POSTING_CHARS)),
    Effect.filterOrFail(
      (text) => text.length > 0,
      () => skip("EmptyPosting", "the posting has no text")
    ),
    Effect.map((text) => ({ company: job.company, text, title: job.title })),
    Effect.flatMap((posting) =>
      claimModelCall.pipe(
        Effect.filterOrFail(
          (claimed) => claimed,
          () =>
            skip(
              "DailyCapReached",
              `the ${dailyModelCalls} model calls for today are spent`
            )
        ),
        Effect.as(posting)
      )
    ),
    Effect.flatMap((posting) =>
      enricher.extract(posting).pipe(
        Effect.mapError((failure) => skip("ModelUnavailable", failure.message)),
        Effect.flatMap((answer) =>
          Schema.decodeUnknownEffect(ModelAnswer)(answer).pipe(
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
          ...listing,
          enrichedAt: yield* Clock.currentTimeMillis,
          model: enricher.model,
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
