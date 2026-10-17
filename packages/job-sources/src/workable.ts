import type { PostingValue } from "@rat-stack/core";
import { Array, Effect, pipe, Schema } from "effect";

import { fetchJson } from "./http.js";
import { epochMillisOf, nonEmpty } from "./parse.js";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const WorkableLocation = Schema.Struct({
  city: OptionalString,
  country: OptionalString,
  hidden: Schema.optional(Schema.NullOr(Schema.Boolean)),
  region: OptionalString,
});

const WorkableJob = Schema.Struct({
  city: OptionalString,
  country: OptionalString,
  created_at: OptionalString,
  locations: Schema.optional(Schema.NullOr(Schema.Array(WorkableLocation))),
  published_on: OptionalString,
  shortcode: Schema.NonEmptyString,
  state: OptionalString,
  telecommuting: Schema.optional(Schema.NullOr(Schema.Boolean)),
  title: Schema.String,
  url: Schema.NonEmptyString,
});

type WorkableJobValue = typeof WorkableJob.Type;

const WidgetAccount = Schema.Struct({ jobs: Schema.Array(Schema.Unknown) });

const placeOf = (place: {
  readonly city?: string | null | undefined;
  readonly country?: string | null | undefined;
  readonly region?: string | null | undefined;
}) => nonEmpty([place.city, place.region, place.country]).join(", ");

const locationOf = (job: WorkableJobValue) => {
  const listed = pipe(
    job.locations ?? [],
    Array.filter((place) => place.hidden !== true),
    Array.map(placeOf)
  );

  return nonEmpty(
    listed.length > 0
      ? listed
      : [placeOf({ city: job.city, country: job.country, region: job.state })]
  ).join("; ");
};

export const workablePostings = (feed: string, slug: string) =>
  fetchJson(
    feed,
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`,
    WidgetAccount
  ).pipe(
    Effect.map(({ jobs }) =>
      pipe(
        jobs,
        Array.map((item) => Schema.decodeUnknownOption(WorkableJob)(item)),
        Array.getSomes,
        Array.map((job): PostingValue => ({
          company: "",
          externalId: job.shortcode,
          location: locationOf(job),
          postedAt: epochMillisOf(job.published_on ?? job.created_at),
          salary: null,
          title: job.title,
          url: job.url,
          workplace: job.telecommuting === true ? "Remote" : "Unspecified",
        }))
      )
    )
  );
