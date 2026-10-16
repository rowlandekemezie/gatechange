import type { PostingValue } from "@rat-stack/core";
import { Array, Effect, pipe, Schema } from "effect";

import { fetchJson } from "./http.js";
import {
  epochMillisOf,
  nonEmpty,
  periodOf,
  salaryRange,
  workplaceOf,
} from "./parse.js";

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
  updated_at: OptionalString,
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
          postedAt: epochMillisOf(job.first_published ?? job.updated_at),
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
  createdAt: OptionalNumber,
  hostedUrl: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
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
        Array.map((job): PostingValue => ({
          company: "",
          externalId: job.id,
          location: nonEmpty([
            ...(job.categories?.allLocations ?? []),
            job.categories?.location,
          ]).join("; "),
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
        }))
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

export const ashbyPostings = (feed: string, slug: string) =>
  fetchJson(
    feed,
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
    JobList
  ).pipe(
    Effect.map(({ jobs }) =>
      pipe(
        jobs,
        Array.map((item) => Schema.decodeUnknownOption(AshbyJob)(item)),
        Array.getSomes,
        Array.filter((job) => job.isListed !== false),
        Array.map((job): PostingValue => ({
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
          workplace:
            job.isRemote === true ? "Remote" : workplaceOf(job.workplaceType),
        }))
      )
    )
  );
