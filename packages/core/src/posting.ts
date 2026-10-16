import { Option, Schema } from "effect";

import { Arrangement, EpochMillis } from "./job.js";
import type { Job } from "./job.js";
import type { FeedRef } from "./feed.js";
import { classifyPlacement, regionWeight } from "./location.js";
import { classifyRole, roleWeight } from "./role.js";

export const Posting = Schema.Struct({
  company: Schema.String,
  externalId: Schema.NonEmptyString,
  location: Schema.String,
  postedAt: Schema.NullOr(EpochMillis),
  salary: Schema.NullOr(Schema.String),
  title: Schema.String,
  url: Schema.NonEmptyString,
  workplace: Arrangement,
});

export type Posting = typeof Posting.Type;

export const SALARY_BONUS = 3;

export const REMOTE_BONUS = 2;

export const RECENCY_PENALTY_PER_DAY = 2.5;

export const DAY_MILLIS = 86_400_000;

const collapseWhitespace = (text: string) => text.replaceAll(/\s+/gu, " ").trim();

export const normalizePosting = (
  feed: FeedRef,
  posting: Posting,
  seenAt: number
): Option.Option<Job> => {
  const title = collapseWhitespace(posting.title);
  const company = collapseWhitespace(
    posting.company.length > 0 ? posting.company : Option.getOrElse(feed.company, () => "")
  );

  if (title.length === 0 || company.length === 0) {
    return Option.none();
  }

  return Option.map(classifyRole(title), (role) => {
    const location = collapseWhitespace(posting.location);
    const placement = classifyPlacement({ text: location, workplace: posting.workplace });
    const salary = posting.salary === null ? null : collapseWhitespace(posting.salary);
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
      url: posting.url,
    };
  });
};
