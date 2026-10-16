import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { FeedStateValue } from "./feed.js";
import type { JobStoreUnavailable } from "./job-store-unavailable.js";
import type {
  BoardStatsValue,
  IngestReceiptValue,
  JobValue,
  JobQueryValue,
} from "./job.js";

export const FeedReplacement = Schema.Struct({
  removed: Schema.Int,
  upserted: Schema.Int,
});

export type FeedReplacementValue = typeof FeedReplacement.Type;

export interface JobListing {
  readonly jobs: readonly JobValue[];
  readonly total: number;
}

export class JobStore extends Context.Service<
  JobStore,
  {
    readonly feedStates: Effect.Effect<
      readonly FeedStateValue[],
      JobStoreUnavailable
    >;
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
