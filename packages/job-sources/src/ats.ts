import {
  annualSalaryBandOf,
  namesVariablePay,
  Posting,
  salaryDisagreesWithText,
} from "@rat-stack/core";
import type {
  PostingValue,
  SalaryBandValue,
  SalaryPeriodValue,
} from "@rat-stack/core";
import { Array, Effect, Match, Option, pipe, Schema } from "effect";

import { fetchJson } from "./http.js";
import {
  epochMillisOf,
  nonEmpty,
  periodOf,
  salaryRange,
  workplaceOf,
} from "./parse.js";
import { ashbyBoardSalary, AshbyDetail } from "./posting-text.js";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Finite));

const JobList = Schema.Struct({ jobs: Schema.Array(Schema.Unknown) });

const GreenhouseJob = Schema.Struct({
  absolute_url: Schema.NonEmptyString,
  first_published: OptionalString,
  id: Schema.Union([Schema.Finite, Schema.String]),
  location: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: OptionalString }))
  ),
  title: Schema.String,
});

export const greenhousePostings = (feed: string, slug: string) =>
  fetchJson(
    feed,
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
    JobList
  ).pipe(
    Effect.map(({ jobs }) =>
      pipe(
        jobs,
        Array.map((item) => Schema.decodeUnknownOption(GreenhouseJob)(item)),
        Array.getSomes,
        Array.map((job): PostingValue => ({
          company: "",
          externalId: String(job.id),
          location: job.location?.name ?? "",
          postedAt: epochMillisOf(job.first_published),
          salary: null,
          title: job.title,
          url: job.absolute_url,
          workplace: "Unspecified",
        }))
      )
    )
  );

const LeverJob = Schema.Struct({
  categories: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        allLocations: Schema.optional(
          Schema.NullOr(Schema.Array(Schema.String))
        ),
        location: OptionalString,
      })
    )
  ),
  country: Posting.fields.country.pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.none()))
  ),
  createdAt: OptionalNumber,
  descriptionPlain: OptionalString,
  hostedUrl: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  salaryDescriptionPlain: OptionalString,
  salaryRange: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        currency: OptionalString,
        interval: OptionalString,
        max: OptionalNumber,
        min: OptionalNumber,
      })
    )
  ),
  text: Schema.String,
  workplaceType: OptionalString,
});

type LeverJobValue = typeof LeverJob.Type;

const LeverSalary = Schema.Struct({
  currency: Schema.String,
  interval: Schema.String,
  max: Schema.Finite,
  min: Schema.Finite,
});

const salaryPeriodOf = (interval: string) =>
  Match.value(periodOf(interval)?.toLowerCase()).pipe(
    Match.withReturnType<SalaryPeriodValue | null>(),
    Match.when("hour", () => "Hour"),
    Match.when("month", () => "Month"),
    Match.when("year", () => "Year"),
    Match.orElse(() => null)
  );

const leverSalaryBand = (job: LeverJobValue): SalaryBandValue | undefined => {
  const range = Option.getOrNull(
    Schema.decodeUnknownOption(LeverSalary)(job.salaryRange)
  );

  const period = range === null ? null : salaryPeriodOf(range.interval);

  if (
    range === null ||
    period === null ||
    namesVariablePay(job.salaryDescriptionPlain ?? "")
  ) {
    return undefined;
  }

  const band = annualSalaryBandOf(
    { currency: range.currency.toUpperCase(), max: range.max, min: range.min },
    period,
    job.text
  );

  return band === null ||
    salaryDisagreesWithText(
      band,
      [job.descriptionPlain, job.salaryDescriptionPlain].join("\n\n"),
      job.text
    )
    ? undefined
    : band;
};

const withSalaryBand = (
  posting: PostingValue,
  band: SalaryBandValue | undefined
): PostingValue =>
  band === undefined ? posting : { ...posting, salaryBand: band };

export const leverPostings = (feed: string, slug: string) =>
  fetchJson(
    feed,
    `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    Schema.Array(Schema.Unknown)
  ).pipe(
    Effect.map((jobs) =>
      pipe(
        jobs,
        Array.map((item) => Schema.decodeUnknownOption(LeverJob)(item)),
        Array.getSomes,
        Array.map((job): PostingValue => {
          const locations = nonEmpty([
            ...(job.categories?.allLocations ?? []),
            job.categories?.location,
          ]);

          const posting: PostingValue = {
            company: "",
            externalId: job.id,
            location: locations.join("; "),
            postedAt: epochMillisOf(job.createdAt),
            salary: salaryRange(
              job.salaryRange?.min,
              job.salaryRange?.max,
              job.salaryRange?.currency,
              periodOf(job.salaryRange?.interval)
            ),
            title: job.text,
            url: job.hostedUrl,
            workplace: workplaceOf(job.workplaceType),
          };

          const banded = withSalaryBand(posting, leverSalaryBand(job));

          if (locations.length <= 1 && job.country !== undefined) {
            return { ...banded, country: job.country };
          }

          return banded;
        })
      )
    )
  );

const AshbyJob = Schema.Struct({
  compensation: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        compensationTierSummary: OptionalString,
        scrapeableCompensationSalarySummary: OptionalString,
      })
    )
  ),
  id: Schema.NonEmptyString,
  isListed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  isRemote: Schema.optional(Schema.NullOr(Schema.Boolean)),
  jobUrl: Schema.NonEmptyString,
  location: OptionalString,
  publishedAt: OptionalString,
  secondaryLocations: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ location: OptionalString })))
  ),
  title: Schema.String,
  workplaceType: OptionalString,
});

const ashbyPosting = (job: typeof AshbyJob.Type): PostingValue => ({
  company: "",
  externalId: job.id,
  location: nonEmpty([
    job.location,
    ...pipe(
      job.secondaryLocations ?? [],
      Array.map((secondary) => secondary.location)
    ),
  ]).join("; "),
  postedAt: epochMillisOf(job.publishedAt),
  salary:
    job.compensation?.scrapeableCompensationSalarySummary ??
    job.compensation?.compensationTierSummary ??
    null,
  title: job.title,
  url: job.jobUrl,
  workplace: job.isRemote === true ? "Remote" : workplaceOf(job.workplaceType),
});

export const ashbyPostings = (feed: string, slug: string) =>
  fetchJson(
    feed,
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
    JobList
  ).pipe(
    Effect.map(({ jobs }) =>
      pipe(
        jobs,
        Array.map((item) =>
          Schema.decodeUnknownOption(AshbyJob)(item).pipe(
            Option.filter((job) => job.isListed !== false),
            Option.map((job) => ({
              band: pipe(
                Schema.decodeUnknownOption(AshbyDetail)(item),
                Option.flatMap((detail) =>
                  Option.fromNullishOr(ashbyBoardSalary(detail, job.title))
                ),
                Option.getOrUndefined
              ),
              job,
            }))
          )
        ),
        Array.getSomes,
        Array.map(({ band, job }) => withSalaryBand(ashbyPosting(job), band))
      )
    )
  );
