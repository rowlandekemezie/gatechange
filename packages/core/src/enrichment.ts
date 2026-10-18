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
]);

export type SkipReasonValue = typeof SkipReason.Type;

export type SkipHandlingValue = "Acknowledge" | "Final" | "Retry";

export const skipHandling: Record<SkipReasonValue, SkipHandlingValue> = {
  AlreadyEnriched: "Acknowledge",
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
  String.raw`(?<floor>\b(?:from|at least|minimum(?: of)?|starting at)\s+)?(?<before>${markerRun})${amountNamed("low")}(?:\s*(?<middle>${markerRun})(?:-|–|—|\bto\b|\band\b)\s*(?<between>${markerRun})${amountNamed("high")})?(?<after>(?:\s*${currencyMarker})?)`,
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

const currencyOfMarkers = (markers: string): string | null => {
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

  return explicit[0] ?? (named.length > 0 ? "USD" : null);
};

const amountOf = (digits: string | undefined, thousands: string | undefined) =>
  Math.round(
    Number((digits ?? "").replaceAll(",", "")) *
      (thousands === undefined ? 1 : 1000)
  );

const periodCue =
  /(?<Hour>(?:\bper\s+|\ban\s+|\/\s*)(?:hour|hr)\b|\bhourly\b)|(?<Month>(?:\bper\s+|\ba\s+|\/\s*)(?:month|mo)\b|\bmonthly\b)|(?<Year>(?:\bper\s+(?:1\s+)?|\ba\s+|\/\s*)(?:year|yr|annum)\b|\bannual(?:ly)?\b|\byearly\b)/giu;

const periodAround = (
  text: string,
  start: number,
  end: number
): SalaryPeriodValue => {
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const lineEnd = text.indexOf("\n", end);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);

  const cues = Array.map([...line.matchAll(periodCue)], (cue) => ({
    at: lineStart + cue.index,
    period: SalaryPeriod.literals.find(
      (period) => cue.groups?.[period] !== undefined
    ),
  }));

  return (
    cues.find((cue) => cue.at >= end)?.period ??
    cues.findLast((cue) => cue.at < start)?.period ??
    "Year"
  );
};

export const moneyRangesIn = (text: string): readonly MoneyRange[] =>
  Array.filterMap([...text.matchAll(moneyPattern)], (match) => {
    const groups = match.groups ?? {};

    const currency = currencyOfMarkers(
      [groups.before, groups.middle, groups.between, groups.after].join(" ")
    );

    if (
      currency === null ||
      (groups.floor !== undefined && groups.high === undefined)
    ) {
      return Result.failVoid;
    }

    return Result.succeed({
      amounts: [
        amountOf(groups.low, groups.lowK),
        ...(groups.high === undefined
          ? []
          : [amountOf(groups.high, groups.highK)]),
      ],
      currency,
      period: periodAround(text, match.index, match.index + match[0].length),
    });
  });

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
    moneyRangesIn(text),
    Array.findFirst((range) =>
      stated.every((amount) => range.amounts.includes(amount))
    ),
    Option.flatMap((range) =>
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
    String.raw`\b(?:not|never|no|non)\b[\s-]+(?:[\w'’]+[\s-]+){0,3}?(?:${claim.source})`,
    "iu"
  );

const quotedWord = (word: string) =>
  word
    .replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
    .replaceAll(/[-–—]/gu, "[-–—]");

const quotedSentence = (
  text: string,
  quote: string | null,
  claim: RegExp
): Option.Option<string> => {
  const words = (quote ?? "").split(/\s+/u).filter((word) => word !== "");

  if (words.length === 0 || !claim.test(words.join(" "))) {
    return Option.none();
  }

  return pipe(
    new RegExp(
      `[^\\n.!?;]*${words.map(quotedWord).join(String.raw`\s+`)}[^\\n.!?;]*`,
      "iu"
    ).exec(text)?.[0],
    Option.fromNullishOr,
    Option.filter(
      (sentence) =>
        !pastExperience.test(sentence) && !negationOf(claim).test(sentence)
    )
  );
};

const peopleCount = (size: number) =>
  new RegExp(
    String.raw`(?:\b${size}\+?\s+(?:[a-z-]+\s+){0,2}(?:people|persons?|engineers|developers|scientists|analysts|designers|managers|leads|members|reports|individuals|employees|staff|sdets|ics)\b|\bteam of (?:about |approximately |around |roughly |~)?${size}\b|\bdirect reports?:?\s*${size}\b)`,
    "iu"
  );

const joinsTeam = /\bjoin(?:s|ing)?\b/iu;

const leadsTeam =
  /\b(?:lead|leads|leading|manage|manages|managing|oversee|oversees|overseeing|run|runs|running|head|heads|direct reports?)\b/iu;

const teamSizeOf = (answer: ModelAnswerValue, text: string) => {
  if (answer.teamSize === null) {
    return null;
  }

  const size = Math.round(answer.teamSize);

  return pipe(
    quotedSentence(text, answer.teamSizeQuote, peopleCount(size)),
    Option.filter(
      (sentence) => !joinsTeam.test(sentence) || leadsTeam.test(sentence)
    ),
    Option.flatMap(() => decodeTeamSize(size)),
    Option.getOrNull
  );
};

const remoteWork = /\bremote\b|\bwork from (?:home|anywhere)\b/iu;

const remotePolicyCues: Record<RemotePolicyValue, RegExp> = {
  Hybrid:
    /\bhybrid\b|\bdays? (?:a|per|each) week\b|\b(?:mon|tues|wednes|thurs|fri)days?\b|\d+% of the time\b/iu,
  Onsite:
    /\bon-?site\b|\bin[- ](?:the )?office\b|\bin[- ]person\b|\b5 days (?:a|per) week\b/iu,
  Remote: remoteWork,
  RemoteInRegion: remoteWork,
};

const occasionalVisits =
  /\btimes?\s*(?:a|per|\/)\s*(?:month|quarter|year)\b|\b(?:monthly|quarterly|occasional(?:ly)?)\b/iu;

const officeShare =
  /\bhybrid (?:work(?:ing)? )?policy\b|\boffices?\b[^.\n]{0,40}\b\d{1,2}% of the time\b/iu;

const workplaceTags: readonly (readonly [RemotePolicyValue, RegExp])[] = [
  ["Remote", /#LI-Remote\b/iu],
  ["Hybrid", /#LI-Hybrid\b/iu],
  ["Onsite", /#LI-On-?site\b/iu],
];

const remotePolicyOf = (
  answer: ModelAnswerValue,
  text: string
): RemotePolicyValue | null => {
  const policy = answer.remotePolicy;

  return pipe(
    Option.fromNullishOr(policy),
    Option.filter((claimed) =>
      pipe(
        quotedSentence(
          text,
          answer.remotePolicyQuote,
          remotePolicyCues[claimed]
        ),
        Option.exists(
          (sentence) =>
            claimed === "Remote" ||
            claimed === "RemoteInRegion" ||
            !occasionalVisits.test(sentence)
        )
      )
    ),
    Option.orElse(() =>
      officeShare.test(text) ? Option.some("Hybrid" as const) : Option.none()
    ),
    Option.orElse(() =>
      pipe(
        workplaceTags,
        Array.findFirst(([, tag]) => tag.test(text)),
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

const reportsToOf = (answer: ModelAnswerValue, text: string) => {
  const title = answer.reportsTo?.replaceAll(/\s+/gu, " ").trim() ?? "";
  const quoted = new Set(titleWords(answer.reportsToQuote ?? ""));

  return pipe(
    quotedSentence(text, answer.reportsToQuote, reportingLine),
    Option.filter(() =>
      Array.every(titleWords(title), (word) => quoted.has(word))
    ),
    Option.flatMap(() => decodeReportsTo(title)),
    Option.getOrNull
  );
};

export const detailsOfAnswer = (
  answer: ModelAnswerValue,
  posting: PostingRequest
): ListingDetailsValue => ({
  remotePolicy: remotePolicyOf(answer, posting.text),
  reportsTo: reportsToOf(answer, posting.text),
  salary: salaryBandOf(answer, posting.text),
  seniority: seniorityOf(posting.title, answer.seniority),
  teamSize: teamSizeOf(answer, posting.text),
});

const HOUR_MILLIS = 3_600_000;

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
  id: string
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
      enricher.extract(posting).pipe(
        Effect.mapError((failure) => skip("ModelUnavailable", failure.message)),
        Effect.flatMap((answer) =>
          Schema.decodeUnknownEffect(ModelAnswer)(answer).pipe(
            Effect.mapError((failure) => skip("Malformed", failure.message))
          )
        ),
        Effect.map((answer) => detailsOfAnswer(answer, posting))
      )
    )
  );

  return yield* details.pipe(
    Effect.matchEffect({
      onFailure: (skipped) =>
        skipHandling[skipped.reason] === "Acknowledge"
          ? Effect.succeed(skipped)
          : Effect.gen(function* recordSkip() {
              yield* store.recordSkip(id, {
                reason: skipped.reason,
                skippedAt: yield* Clock.currentTimeMillis,
              });

              return skipped;
            }),
      onSuccess: (listing) =>
        Effect.gen(function* saveListing() {
          const enrichment: EnrichmentValue = {
            ...listing,
            enrichedAt: yield* Clock.currentTimeMillis,
            model: enricher.model,
          };

          yield* store.saveEnrichment(id, enrichment);

          return EnrichmentOutcome.Enriched({ enrichment, id });
        }),
    })
  );
});
