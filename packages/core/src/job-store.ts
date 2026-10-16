import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { FeedState } from "./feed.js";
import type { BoardStats, IngestReceipt, Job, JobQuery } from "./job.js";
import type { JobStoreUnavailable } from "./job-store-unavailable.js";

export const FeedReplacement = Schema.Struct({
  removed: Schema.Int,
  upserted: Schema.Int,
});

export type FeedReplacement = typeof FeedReplacement.Type;

export interface JobListing {
  readonly jobs: ReadonlyArray<Job>;
  readonly total: number;
}

export class JobStore extends Context.Service<
  JobStore,
  {
    readonly feedStates: Effect.Effect<ReadonlyArray<FeedState>, JobStoreUnavailable>;
    readonly list: (
      query: JobQuery,
      now: number
    ) => Effect.Effect<JobListing, JobStoreUnavailable>;
    readonly pruneOlderThan: (cutoff: number) => Effect.Effect<number, JobStoreUnavailable>;
    readonly recordFeedFailure: (
      feedKey: string,
      attemptedAt: number,
      message: string
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly recordRun: (receipt: IngestReceipt) => Effect.Effect<void, JobStoreUnavailable>;
    readonly replaceFeed: (
      feedKey: string,
      jobs: ReadonlyArray<Job>,
      seenAt: number
    ) => Effect.Effect<FeedReplacement, JobStoreUnavailable>;
    readonly stats: (
      now: number
    ) => Effect.Effect<Omit<BoardStats, "generatedAt">, JobStoreUnavailable>;
  }
>()("@rat-stack/core/JobStore") {}
