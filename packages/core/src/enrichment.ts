import {
  Array,
  Clock,
  Context,
  Data,
  Effect,
  Option,
  pipe,
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
  SalaryBandValue,
  SourceNameValue,
} from "./job.js";
import { PostingTexts } from "./posting-texts.js";
import { SourceTerms } from "./source-terms.js";

export const MAX_POSTING_CHARS = 12_000;

export const SalaryPeriod = Schema.Literals(["Year", "Month", "Hour"]);

export type SalaryPeriodValue = typeof SalaryPeriod.Type;

export const ModelAnswer = Schema.Struct({
  remotePolicy: Schema.NullOr(RemotePolicy),
  reportsTo: Schema.NullOr(Schema.String),
  salaryCurrency: Schema.NullOr(Schema.String),
  salaryMax: Schema.NullOr(Schema.Finite),
  salaryMin: Schema.NullOr(Schema.Finite),
  salaryPeriod: Schema.NullOr(SalaryPeriod),
  seniority: Schema.NullOr(Seniority),
  teamSize: Schema.NullOr(Schema.Finite),
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
  "ModelUnavailable",
  "Malformed",
]);

export type SkipReasonValue = typeof SkipReason.Type;

export const retryableSkips: readonly SkipReasonValue[] = [
  "PostingUnavailable",
  "ModelUnavailable",
];

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

const HOURS_PER_YEAR = 2080;

const periodFactor: Record<SalaryPeriodValue, number> = {
  Hour: HOURS_PER_YEAR,
  Month: 12,
  Year: 1,
};

export const amountsIn = (text: string): ReadonlySet<number> =>
  new Set(
    Array.map(
      [
        ...text.matchAll(
          /(?<digits>\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(?<thousands>[kK])?/gu
        ),
      ],
      ({ groups }) =>
        Math.round(
          Number((groups?.digits ?? "").replaceAll(",", "")) *
            (groups?.thousands === undefined ? 1 : 1000)
        )
    )
  );

const salaryBandOf = (
  answer: ModelAnswerValue,
  text: string
): SalaryBandValue | null => {
  const stated = Array.filter(
    [answer.salaryMin, answer.salaryMax],
    (amount): amount is number => amount !== null && amount > 0
  );

  const quoted = amountsIn(text);

  if (!stated.some((amount) => quoted.has(amount))) {
    return null;
  }

  const factor = periodFactor[answer.salaryPeriod ?? "Year"];

  return pipe(
    Schema.decodeUnknownOption(SalaryBand)({
      currency: answer.salaryCurrency?.trim().toUpperCase(),
      max: Math.round(Math.max(...stated) * factor),
      min: Math.round(Math.min(...stated) * factor),
    }),
    Option.getOrNull
  );
};

const decodeReportsTo = Schema.decodeUnknownOption(
  ListingDetails.fields.reportsTo
);

const decodeTeamSize = Schema.decodeUnknownOption(
  ListingDetails.fields.teamSize
);

export const detailsOfAnswer = (
  answer: ModelAnswerValue,
  text: string
): ListingDetailsValue => ({
  remotePolicy: answer.remotePolicy,
  reportsTo: pipe(
    decodeReportsTo(answer.reportsTo?.replaceAll(/\s+/gu, " ").trim() ?? ""),
    Option.getOrNull
  ),
  salary: salaryBandOf(answer, text),
  seniority: answer.seniority,
  teamSize: pipe(
    decodeTeamSize(
      answer.teamSize === null ? null : Math.round(answer.teamSize)
    ),
    Option.getOrNull
  ),
});

export const enqueueNewListings = Effect.fn("enqueueNewListings")(
  function* enqueueNewListings(seenAt: number) {
    const store = yield* JobStore;
    const queue = yield* EnrichmentQueue;
    const ids = yield* store.newListings(seenAt, enrichableSources);

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
    Effect.mapError((failure) => skip("PostingUnavailable", failure.message)),
    Effect.map((text) => text.slice(0, MAX_POSTING_CHARS)),
    Effect.flatMap((text) =>
      enricher.extract({ company: job.company, text, title: job.title }).pipe(
        Effect.mapError((failure) => skip("ModelUnavailable", failure.message)),
        Effect.flatMap((answer) =>
          Schema.decodeUnknownEffect(ModelAnswer)(answer).pipe(
            Effect.mapError((failure) => skip("Malformed", failure.message))
          )
        ),
        Effect.map((answer) => detailsOfAnswer(answer, text))
      )
    )
  );

  return yield* details.pipe(
    Effect.matchEffect({
      onFailure: Effect.succeed,
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
