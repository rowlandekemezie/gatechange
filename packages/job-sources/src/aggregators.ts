import { Array, Effect, pipe, Schema } from "effect";
import type { Posting } from "@rat-stack/core";

import { fetchJson } from "./http.js";
import { epochMillisOf, nonEmpty, salaryRange, textOfHtml } from "./parse.js";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Finite));

const Identifier = Schema.Union([Schema.Finite, Schema.NonEmptyString]);

const RemoteOkJob = Schema.Struct({
  company: Schema.String,
  epoch: OptionalNumber,
  id: Identifier,
  location: OptionalString,
  position: Schema.String,
  salary_max: OptionalNumber,
  salary_min: OptionalNumber,
  url: Schema.NonEmptyString,
});

export const remoteOkPostings = (feed: string) =>
  fetchJson(feed, "https://remoteok.com/api", Schema.Array(Schema.Unknown)).pipe(
    Effect.map((jobs) =>
      pipe(
        jobs,
        Array.map((item) => Schema.decodeUnknownOption(RemoteOkJob)(item)),
        Array.getSomes,
        Array.map(
          (job): Posting => ({
            company: job.company,
            externalId: String(job.id),
            location: job.location ?? "",
            postedAt: epochMillisOf(job.epoch),
            salary: salaryRange(job.salary_min, job.salary_max, "USD", "year"),
            title: job.position,
            url: job.url,
            workplace: "Remote",
          })
        )
      )
    )
  );

const RemotiveJob = Schema.Struct({
  candidate_required_location: OptionalString,
  company_name: Schema.String,
  id: Identifier,
  publication_date: OptionalString,
  salary: OptionalString,
  title: Schema.String,
  url: Schema.NonEmptyString,
});

export const remotivePostings = (feed: string, search: string) =>
  fetchJson(
    feed,
    `https://remotive.com/api/remote-jobs?category=software-dev&search=${encodeURIComponent(search)}`,
    Schema.Struct({ jobs: Schema.Array(Schema.Unknown) })
  ).pipe(
    Effect.map(({ jobs }) =>
      pipe(
        jobs,
        Array.map((item) => Schema.decodeUnknownOption(RemotiveJob)(item)),
        Array.getSomes,
        Array.map(
          (job): Posting => ({
            company: job.company_name,
            externalId: String(job.id),
            location: job.candidate_required_location ?? "",
            postedAt: epochMillisOf(job.publication_date),
            salary: job.salary === null || job.salary === undefined || job.salary.length === 0 ? null : job.salary,
            title: job.title,
            url: job.url,
            workplace: "Remote",
          })
        )
      )
    )
  );

const HimalayasJob = Schema.Struct({
  applicationLink: OptionalString,
  companyName: Schema.String,
  currency: OptionalString,
  guid: Schema.NonEmptyString,
  locationRestrictions: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  maxSalary: OptionalNumber,
  minSalary: OptionalNumber,
  pubDate: Schema.optional(Schema.NullOr(Schema.Union([Schema.Finite, Schema.String]))),
  salaryPeriod: OptionalString,
  title: Schema.String,
});

export const himalayasPostings = (feed: string, query: string) =>
  fetchJson(
    feed,
    `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(query)}&sort=recent`,
    Schema.Struct({ jobs: Schema.optional(Schema.Array(Schema.Unknown)) })
  ).pipe(
    Effect.map(({ jobs }) =>
      pipe(
        jobs ?? [],
        Array.map((item) => Schema.decodeUnknownOption(HimalayasJob)(item)),
        Array.getSomes,
        Array.map(
          (job): Posting => ({
            company: job.companyName,
            externalId: job.guid,
            location: nonEmpty(job.locationRestrictions ?? []).join("; "),
            postedAt: epochMillisOf(job.pubDate),
            salary: salaryRange(job.minSalary, job.maxSalary, job.currency, job.salaryPeriod),
            title: job.title,
            url: job.applicationLink ?? job.guid,
            workplace: "Remote",
          })
        )
      )
    )
  );

const JobicyJob = Schema.Struct({
  companyName: Schema.String,
  id: Identifier,
  jobGeo: OptionalString,
  jobTitle: Schema.String,
  pubDate: OptionalString,
  salaryCurrency: OptionalString,
  salaryMax: OptionalNumber,
  salaryMin: OptionalNumber,
  salaryPeriod: OptionalString,
  url: Schema.NonEmptyString,
});

export const jobicyPostings = (feed: string, tag: string) =>
  fetchJson(
    feed,
    `https://jobicy.com/api/v2/remote-jobs?count=100&tag=${encodeURIComponent(tag)}`,
    Schema.Struct({ jobs: Schema.optional(Schema.Array(Schema.Unknown)) })
  ).pipe(
    Effect.map(({ jobs }) =>
      pipe(
        jobs ?? [],
        Array.map((item) => Schema.decodeUnknownOption(JobicyJob)(item)),
        Array.getSomes,
        Array.map(
          (job): Posting => ({
            company: textOfHtml(job.companyName),
            externalId: String(job.id),
            location: job.jobGeo ?? "",
            postedAt: epochMillisOf(job.pubDate),
            salary: salaryRange(job.salaryMin, job.salaryMax, job.salaryCurrency, job.salaryPeriod),
            title: textOfHtml(job.jobTitle),
            url: job.url,
            workplace: "Remote",
          })
        )
      )
    )
  );
