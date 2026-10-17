import type { ArrangementValue, PostingValue } from "@rat-stack/core";
import { Array, Effect, pipe, Schema } from "effect";

import { fetchJson } from "./http.js";
import { epochMillisOf, nonEmpty } from "./parse.js";

export const SMARTRECRUITERS_PAGE_SIZE = 100;

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const OptionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));

const SmartRecruitersPosting = Schema.Struct({
  company: Schema.Struct({ identifier: Schema.NonEmptyString }),
  id: Schema.NonEmptyString,
  location: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        city: OptionalString,
        country: OptionalString,
        fullLocation: OptionalString,
        hybrid: OptionalBoolean,
        region: OptionalString,
        remote: OptionalBoolean,
      })
    )
  ),
  name: Schema.String,
  releasedDate: OptionalString,
});

type SmartRecruitersPostingValue = typeof SmartRecruitersPosting.Type;

const PostingPage = Schema.Struct({ content: Schema.Array(Schema.Unknown) });

const workplaceOf = (job: SmartRecruitersPostingValue): ArrangementValue => {
  if (job.location?.remote === true) {
    return "Remote";
  }

  return job.location?.hybrid === true ? "Hybrid" : "Unspecified";
};

export const smartRecruitersPostings = (feed: string, slug: string) =>
  fetchJson(
    feed,
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=${SMARTRECRUITERS_PAGE_SIZE}`,
    PostingPage
  ).pipe(
    Effect.map(({ content }) =>
      pipe(
        content,
        Array.map((item) =>
          Schema.decodeUnknownOption(SmartRecruitersPosting)(item)
        ),
        Array.getSomes,
        Array.map((job): PostingValue => ({
          company: "",
          externalId: job.id,
          location:
            job.location?.fullLocation ??
            nonEmpty([
              job.location?.city,
              job.location?.region,
              job.location?.country,
            ]).join(", "),
          postedAt: epochMillisOf(job.releasedDate),
          salary: null,
          title: job.name,
          url: `https://jobs.smartrecruiters.com/${encodeURIComponent(job.company.identifier)}/${encodeURIComponent(job.id)}`,
          workplace: workplaceOf(job),
        }))
      )
    )
  );
