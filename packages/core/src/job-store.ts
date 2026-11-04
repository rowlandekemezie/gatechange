import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { BoardFactsRow } from "./board-facts.js";
import type { CompanyRecords } from "./company-intel.js";
import type { CompanyJobsValue } from "./company-jobs.js";
import type { SkipReasonValue } from "./enrichment.js";
import type { FeedStateValue } from "./feed.js";
import type { JobStoreUnavailable } from "./job-store-unavailable.js";
import type {
  BoardStatsValue,
  SitemapJobValue,
  EnrichmentValue,
  IngestReceiptValue,
  JobDetailValue,
  JobValue,
  JobQueryValue,
  ListedJobValue,
  SourceNameValue,
} from "./job.js";
import type { Retention } from "./listing-status.js";
import { DAY_MILLIS } from "./posting.js";

export const FeedReplacement = Schema.Struct({
  departed: Schema.Int,
  upserted: Schema.Int,
});

export type FeedReplacementValue = typeof FeedReplacement.Type;

export interface EnrichmentSkip {
  readonly reason: SkipReasonValue;
  readonly skippedAt: number;
}

export interface NeuronClaim {
  readonly budget: number;
  readonly day: number;
  readonly neurons: number;
}

export interface NeuronUsage {
  readonly claimed: number;
  readonly day: number;
  readonly neurons: number;
}

export interface UnenrichedSweep {
  readonly finalSkips: readonly SkipReasonValue[];
  readonly limit: number;
  readonly promptVersion: number;
  readonly since: number;
  readonly sources: readonly SourceNameValue[];
}

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

export type Sighted = Pick<JobValue, "company" | "feed" | "postedAt" | "title">;

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
    readonly claimIngest: (
      startedAt: number,
      heldUntil: number
    ) => Effect.Effect<boolean, JobStoreUnavailable>;
    readonly claimNeurons: (
      claim: NeuronClaim
    ) => Effect.Effect<boolean, JobStoreUnavailable>;
    readonly companyJobs: (
      slug: string,
      now: number
    ) => Effect.Effect<
      Omit<CompanyJobsValue, "generatedAt">,
      JobStoreUnavailable
    >;
    readonly companyRecords: (
      slug: string,
      now: number
    ) => Effect.Effect<CompanyRecords, JobStoreUnavailable>;
    readonly feedStates: Effect.Effect<
      readonly FeedStateValue[],
      JobStoreUnavailable
    >;
    readonly find: (
      id: string
    ) => Effect.Effect<Option.Option<JobDetailValue>, JobStoreUnavailable>;
    readonly findIncludingDeparted: (
      id: string
    ) => Effect.Effect<Option.Option<JobDetailValue>, JobStoreUnavailable>;
    readonly heldListings: (
      feedKey: string,
      ids: readonly string[]
    ) => Effect.Effect<readonly string[], JobStoreUnavailable>;
    readonly historyOf: (
      job: Pick<JobValue, "company" | "title">
    ) => Effect.Effect<Option.Option<ListingHistory>, JobStoreUnavailable>;
    readonly list: (
      query: JobQueryValue,
      now: number,
      sources: readonly SourceNameValue[]
    ) => Effect.Effect<JobListing, JobStoreUnavailable>;
    readonly neuronsClaimed: (
      day: number
    ) => Effect.Effect<number, JobStoreUnavailable>;
    readonly markListed: (
      feedKey: string,
      ids: readonly string[],
      seenAt: number
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly prune: (
      retention: Retention
    ) => Effect.Effect<number, JobStoreUnavailable>;
    readonly recordFeedFailure: (
      feedKey: string,
      attemptedAt: number,
      message: string
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly recordSkip: (
      id: string,
      skip: EnrichmentSkip
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly recordNeuronsUsed: (
      usage: NeuronUsage
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly recordRun: (
      receipt: IngestReceiptValue
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly recordSightings: (
      listings: readonly Sighted[],
      seenAt: number
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly releaseIngest: (
      startedAt: number
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly replaceFeed: (
      feedKey: string,
      jobs: readonly JobValue[],
      seenAt: number,
      departPostedBefore?: number
    ) => Effect.Effect<FeedReplacementValue, JobStoreUnavailable>;
    readonly saveBoardFacts: (
      rows: readonly BoardFactsRow[],
      seenAt: number
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly saveEnrichment: (
      id: string,
      enrichment: EnrichmentValue
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly stats: (
      now: number,
      sources: readonly SourceNameValue[],
      catalogKeys: readonly string[]
    ) => Effect.Effect<
      Omit<BoardStatsValue, "generatedAt">,
      JobStoreUnavailable
    >;
    readonly sitemapJobs: (
      now: number,
      sources: readonly SourceNameValue[]
    ) => Effect.Effect<readonly SitemapJobValue[], JobStoreUnavailable>;
    readonly unenrichedListings: (
      sweep: UnenrichedSweep
    ) => Effect.Effect<readonly string[], JobStoreUnavailable>;
  }
>()("@rat-stack/core/JobStore") {}
