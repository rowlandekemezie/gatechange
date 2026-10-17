import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { FeedStateValue } from "./feed.js";
import type { JobStoreUnavailable } from "./job-store-unavailable.js";
import type {
  BoardStatsValue,
  IngestReceiptValue,
  JobValue,
  JobQueryValue,
  ListedJobValue,
} from "./job.js";
import { DAY_MILLIS } from "./posting.js";

export const FeedReplacement = Schema.Struct({
  removed: Schema.Int,
  upserted: Schema.Int,
});

export type FeedReplacementValue = typeof FeedReplacement.Type;

export interface JobListing {
  readonly jobs: readonly ListedJobValue[];
  readonly total: number;
}

export interface ListingHistory {
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly reposts: number;
  readonly sightings: number;
}

export const fingerprintOf = (job: Pick<JobValue, "company" | "title">) =>
  `${job.company}|${job.title}`.toLowerCase().replaceAll(/[^a-z0-9|]+/gu, "");

export const daysOpen = (firstSeenAt: number, now: number) =>
  Math.max(0, Math.floor((now - firstSeenAt) / DAY_MILLIS));

export const REPOST_GAP = 7 * DAY_MILLIS;

interface Sighting {
  readonly lastSeenAt: number;
  readonly lastSeenFeedSuccessAt: number | null;
  readonly seenAt: number;
}

export const isRepost = ({
  lastSeenAt,
  lastSeenFeedSuccessAt,
  seenAt,
}: Sighting) =>
  lastSeenAt < seenAt - REPOST_GAP && lastSeenAt < (lastSeenFeedSuccessAt ?? 0);

export class JobStore extends Context.Service<
  JobStore,
  {
    readonly feedStates: Effect.Effect<
      readonly FeedStateValue[],
      JobStoreUnavailable
    >;
    readonly historyOf: (
      job: Pick<JobValue, "company" | "title">
    ) => Effect.Effect<Option.Option<ListingHistory>, JobStoreUnavailable>;
    readonly list: (
      query: JobQueryValue,
      now: number
    ) => Effect.Effect<JobListing, JobStoreUnavailable>;
    readonly pruneOlderThan: (
      cutoff: number
    ) => Effect.Effect<number, JobStoreUnavailable>;
    readonly recordFeedFailure: (
      feedKey: string,
      attemptedAt: number,
      message: string
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly recordRun: (
      receipt: IngestReceiptValue
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly replaceFeed: (
      feedKey: string,
      jobs: readonly JobValue[],
      seenAt: number
    ) => Effect.Effect<FeedReplacementValue, JobStoreUnavailable>;
    readonly stats: (
      now: number
    ) => Effect.Effect<
      Omit<BoardStatsValue, "generatedAt">,
      JobStoreUnavailable
    >;
  }
>()("@rat-stack/core/JobStore") {}
