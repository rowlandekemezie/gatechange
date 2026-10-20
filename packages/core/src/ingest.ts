import { Array, Clock, Effect, Option, pipe, Schema } from "effect";

import { selectDueFeeds } from "./feed.js";
import type { FeedOutcomeValue, FeedRef } from "./feed.js";
import { JobStore } from "./job-store.js";
import type { Sighted } from "./job-store.js";
import { MAX_AGE_DAYS } from "./job.js";
import type { IngestReceiptValue, JobValue } from "./job.js";
import { PostingFeeds } from "./posting-feeds.js";
import { DAY_MILLIS, normalizePosting } from "./posting.js";
import type { PostingValue } from "./posting.js";

export interface IngestPlan {
  readonly feedConcurrency: number;
  readonly feedsPerRun: number;
}

export const INGEST_LEASE_MILLIS = 15 * 60 * 1000;

export class IngestInProgress extends Schema.TaggedError<IngestInProgress>()(
  "IngestInProgress",
  { startedAt: Schema.Finite }
) {}

export const retentionCutoff = (now: number) => now - MAX_AGE_DAYS * DAY_MILLIS;

export interface FeedListings {
  readonly jobs: readonly JobValue[];
  readonly unlinked: readonly Sighted[];
  readonly historySightings: readonly Sighted[];
}

export const listingsFromPostings = (
  feed: FeedRef,
  postings: readonly PostingValue[],
  seenAt: number
): FeedListings => {
  const listings = pipe(
    postings,
    Array.map((posting) =>
      normalizePosting(feed, posting, seenAt).pipe(
        Option.map((listing) => ({
          fromCatalog: Option.isSome(feed.company) && posting.company === "",
          listing,
        }))
      )
    ),
    Array.getSomes,
    Array.filter(({ listing }) => listing.postedAt >= retentionCutoff(seenAt)),
    Array.dedupeWith((left, right) => left.listing.id === right.listing.id)
  );

  const jobs: JobValue[] = [];
  const unlinked: Sighted[] = [];
  const historySightings: Sighted[] = [];

  for (const { listing, fromCatalog } of listings) {
    const { url, ...sighting } = listing;

    if (Option.isSome(url)) {
      jobs.push({ ...sighting, url: url.value });
    } else {
      unlinked.push(sighting);

      if (fromCatalog) {
        historySightings.push(sighting);
      }
    }
  }

  return { historySightings, jobs, unlinked };
};

const warnOfUnlinked = (feed: FeedRef, unlinked: readonly Sighted[]) =>
  unlinked.length === 0
    ? Effect.void
    : Effect.logWarning(
        "kept roles without an off-site web link off the board"
      ).pipe(
        Effect.annotateLogs({ feed: feed.key, unlinked: unlinked.length })
      );

const ingestFeed = Effect.fn("ingestFeed")(function* ingestFeed(
  feed: FeedRef,
  seenAt: number
) {
  const store = yield* JobStore;
  const feeds = yield* PostingFeeds;

  return yield* feeds.fetch(feed).pipe(
    Effect.matchEffect({
      onFailure: (failure) =>
        store.recordFeedFailure(feed.key, seenAt, failure.message).pipe(
          Effect.as<FeedOutcomeValue>({
            error: failure.message,
            key: feed.key,
            pruned: 0,
            source: feed.source,
            upserted: 0,
          })
        ),
      onSuccess: (postings) => {
        const { jobs, unlinked, historySightings } = listingsFromPostings(
          feed,
          postings,
          seenAt
        );

        return store.recordSightings(historySightings, seenAt).pipe(
          Effect.andThen(store.replaceFeed(feed.key, jobs, seenAt)),
          Effect.tap(() => warnOfUnlinked(feed, unlinked)),
          Effect.map((replacement): FeedOutcomeValue => ({
            error: null,
            key: feed.key,
            pruned: replacement.removed,
            source: feed.source,
            upserted: replacement.upserted,
          }))
        );
      },
    })
  );
});

const outcomeOf = (
  attempted: number,
  failed: number
): IngestReceiptValue["outcome"] => {
  if (failed === 0) {
    return "Succeeded";
  }

  if (failed === attempted) {
    return "Failed";
  }

  return "Partial";
};

const ingestDueFeeds = Effect.fn("ingestDueFeeds")(function* ingestDueFeeds(
  plan: IngestPlan,
  startedAt: number
) {
  const store = yield* JobStore;
  const feeds = yield* PostingFeeds;
  const states = yield* store.feedStates;

  const due = selectDueFeeds(
    feeds.catalog,
    states,
    startedAt,
    plan.feedsPerRun
  );

  const outcomes = yield* Effect.forEach(
    due,
    (feed) => ingestFeed(feed, startedAt),
    {
      concurrency: plan.feedConcurrency,
    }
  );

  const expired = yield* store.pruneOlderThan(retentionCutoff(startedAt));
  const finishedAt = yield* Clock.currentTimeMillis;

  const failed = pipe(
    outcomes,
    Array.filter((outcome) => outcome.error !== null)
  ).length;

  const receipt: IngestReceiptValue = {
    feedsAttempted: outcomes.length,
    feedsFailed: failed,
    finishedAt,
    jobsPruned:
      expired +
      Array.reduce(outcomes, 0, (total, outcome) => total + outcome.pruned),
    jobsUpserted: Array.reduce(
      outcomes,
      0,
      (total, outcome) => total + outcome.upserted
    ),
    outcome: outcomeOf(outcomes.length, failed),
    startedAt,
  };

  yield* store.recordRun(receipt);

  return { outcomes, receipt };
});

export const runIngest = Effect.fn("runIngest")(function* runIngest(
  plan: IngestPlan
) {
  const store = yield* JobStore;
  const startedAt = yield* Clock.currentTimeMillis;

  return yield* Effect.acquireUseRelease(
    store.claimIngest(startedAt, startedAt + INGEST_LEASE_MILLIS).pipe(
      Effect.filterOrFail(
        (claimed) => claimed,
        () => new IngestInProgress({ startedAt })
      )
    ),
    () => ingestDueFeeds(plan, startedAt),
    () => store.releaseIngest(startedAt)
  );
});
