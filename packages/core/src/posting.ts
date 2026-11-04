import { Option, Schema, pipe } from "effect";

import type { FeedRef } from "./feed.js";
import { Arrangement, EpochMillis, SalaryBand } from "./job.js";
import type { JobValue } from "./job.js";
import { classifyPlacement, regionWeight } from "./location.js";
import { classifyRole, roleWeight } from "./role.js";
import { offSiteHref } from "./site.js";

export const Posting = Schema.Struct({
  company: Schema.String,
  country: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/u))
  ),
  externalId: Schema.NonEmptyString,
  location: Schema.String,
  postedAt: Schema.NullOr(EpochMillis),
  salary: Schema.NullOr(Schema.String),
  salaryBand: Schema.optional(SalaryBand),
  title: Schema.String,
  url: Schema.NonEmptyString,
  workplace: Arrangement,
});

export type PostingValue = typeof Posting.Type;

export interface Listing extends Omit<JobValue, "url"> {
  readonly url: Option.Option<string>;
}

export const SALARY_BONUS = 3;

export const REMOTE_BONUS = 2;

export const RECENCY_PENALTY_PER_DAY = 2.5;

export const DAY_MILLIS = 86_400_000;

export const MAX_TITLE_LENGTH = 500;

export const MAX_DETAIL_LENGTH = 1000;

export const MAX_URL_LENGTH = 2048;

const cleanText = (text: string) =>
  text
    .replaceAll("\u0000", "")
    .replaceAll(/\p{Cs}/gu, "\uFFFD")
    .replaceAll(/\s+/gu, " ")
    .trim();

const boundedDetail = (text: string) =>
  cleanText(cleanText(text).slice(0, MAX_DETAIL_LENGTH));

export const normalizePosting = (
  feed: FeedRef,
  posting: PostingValue,
  seenAt: number
): Option.Option<Listing> => {
  const title = cleanText(posting.title);

  const company = cleanText(
    posting.company.length > 0
      ? posting.company
      : Option.getOrElse(feed.company, () => "")
  );

  if (
    title.length === 0 ||
    company.length === 0 ||
    title.length > MAX_TITLE_LENGTH ||
    company.length > MAX_TITLE_LENGTH ||
    posting.externalId.length > MAX_TITLE_LENGTH ||
    posting.url.length > MAX_URL_LENGTH
  ) {
    return Option.none();
  }

  return pipe(
    classifyRole(title),
    Option.map((role) => {
      const location = boundedDetail(posting.location);

      const placement = classifyPlacement({
        country: posting.country,
        text: location,
        workplace: posting.workplace,
      });

      const salary =
        posting.salary === null ? null : boundedDetail(posting.salary);

      const hasSalary = salary !== null && salary.length > 0;

      return {
        arrangement: placement.arrangement,
        company,
        feed: feed.key,
        firstSeenAt: seenAt,
        id: `${feed.key}:${posting.externalId}`,
        lastSeenAt: seenAt,
        location,
        postedAt: Math.min(posting.postedAt ?? seenAt, seenAt),
        region: placement.region,
        relevance:
          roleWeight(role) +
          regionWeight(placement.region) +
          (hasSalary ? SALARY_BONUS : 0) +
          (placement.arrangement === "Remote" ? REMOTE_BONUS : 0),
        role,
        salary: hasSalary ? salary : null,
        source: feed.source,
        title,
        url: offSiteHref(posting.url),
      };
    })
  );
};
