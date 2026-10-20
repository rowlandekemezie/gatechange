import { FeedUnavailable } from "@rat-stack/core";
import type { ArrangementValue, PostingValue } from "@rat-stack/core";
import { Array, Effect, Option, pipe, Schema } from "effect";

import { fetchJson } from "./http.js";
import { epochMillisOf, nonEmpty } from "./parse.js";

export const SMARTRECRUITERS_PAGE_SIZE = 100;

export const SMARTRECRUITERS_MAX_POSTINGS = 500;

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const OptionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));

export const SmartRecruitersLocation = Schema.Struct({
  city: OptionalString,
  country: OptionalString,
  fullLocation: OptionalString,
  hybrid: OptionalBoolean,
  region: OptionalString,
  remote: OptionalBoolean,
});

const SmartRecruitersPosting = Schema.Struct({
  company: Schema.Struct({ identifier: Schema.NonEmptyString }),
  id: Schema.NonEmptyString,
  location: Schema.optional(Schema.NullOr(SmartRecruitersLocation)),
  name: Schema.String,
  releasedDate: OptionalString,
});

type SmartRecruitersPostingValue = typeof SmartRecruitersPosting.Type;

const PostingPage = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  totalFound: Schema.Int,
});

const PostingId = Schema.Struct({ id: Schema.String });

export const smartRecruitersWorkplaceOf = (
  location: typeof SmartRecruitersLocation.Type | null | undefined
): ArrangementValue => {
  if (location?.remote === true) {
    return "Remote";
  }

  return location?.hybrid === true ? "Hybrid" : "Unspecified";
};

const pageUrl = (slug: string, offset: number) =>
  `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?offset=${offset}&limit=${SMARTRECRUITERS_PAGE_SIZE}`;

const postingOf = (job: SmartRecruitersPostingValue): PostingValue => ({
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
  workplace: smartRecruitersWorkplaceOf(job.location),
});

const readAllPages = (feed: string, slug: string) =>
  Effect.gen(function* readSmartRecruitersPages() {
    const first = yield* fetchJson(feed, pageUrl(slug, 0), PostingPage);

    if (first.totalFound === 0) {
      return yield* new FeedUnavailable({
        feed,
        message: "SmartRecruiters lists no postings for this company",
      });
    }

    if (first.totalFound > SMARTRECRUITERS_MAX_POSTINGS) {
      return yield* new FeedUnavailable({
        feed,
        message: `SmartRecruiters lists ${first.totalFound} postings, over the ${SMARTRECRUITERS_MAX_POSTINGS} cap`,
      });
    }

    const rest = yield* Effect.forEach(
      pipe(
        Array.range(
          0,
          Math.ceil(first.totalFound / SMARTRECRUITERS_PAGE_SIZE) - 1
        ),
        Array.drop(1),
        Array.map((page) => page * SMARTRECRUITERS_PAGE_SIZE)
      ),
      (offset) => fetchJson(feed, pageUrl(slug, offset), PostingPage)
    );

    const content = [first, ...rest].flatMap((page) => page.content);

    const distinct = new Set(
      content.map((item, index) =>
        Option.match(Schema.decodeUnknownOption(PostingId)(item), {
          onNone: () => `unidentified:${index}`,
          onSome: (posting) => posting.id,
        })
      )
    ).size;

    if (distinct < first.totalFound) {
      return yield* new FeedUnavailable({
        feed,
        message: `SmartRecruiters returned ${distinct} distinct of ${first.totalFound} postings`,
      });
    }

    return content;
  });

export const smartRecruitersPostings = (feed: string, slug: string) =>
  readAllPages(feed, slug).pipe(
    Effect.map((content) =>
      pipe(
        content,
        Array.map((item) =>
          Schema.decodeUnknownOption(SmartRecruitersPosting)(item)
        ),
        Array.getSomes,
        Array.map(postingOf)
      )
    )
  );
