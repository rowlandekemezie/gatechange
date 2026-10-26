import { Array, Clock, Effect, Option, pipe, Schema } from "effect";

import { boardFactsOf } from "./board-facts.js";
import type { BoardFactsRow } from "./board-facts.js";
import { selectDueFeeds } from "./feed.js";
import type { FeedOutcomeValue, FeedRef } from "./feed.js";
import { JobStore } from "./job-store.js";
import type { Sighted } from "./job-store.js";
import { MAX_AGE_DAYS } from "./job.js";
import type { IngestReceiptValue, JobValue } from "./job.js";
import { retentionAt } from "./listing-status.js";
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

export const admissionCutoff = (now: number) => now - MAX_AGE_DAYS * DAY_MILLIS;

export interface FeedListings {
  readonly boardFacts: readonly BoardFactsRow[];
  readonly jobs: readonly JobValue[];
  readonly stillListed: readonly string[];
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
          posting,
        }))
      )
    ),
    Array.getSomes,
    Array.dedupeWith((left, right) => left.listing.id === right.listing.id)
  );

  const boardFacts: BoardFactsRow[] = [];
  const jobs: JobValue[] = [];
  const stillListed: string[] = [];
  const unlinked: Sighted[] = [];
  const historySightings: Sighted[] = [];

  for (const { listing, fromCatalog, posting } of listings) {
    const { url, ...sighting } = listing;

    if (listing.postedAt < admissionCutoff(seenAt)) {
      stillListed.push(listing.id);
    } else if (Option.isSome(url)) {
      jobs.push({ ...sighting, url: url.value });

      const facts = boardFactsOf(listing, posting);

      if (facts !== null) {
        boardFacts.push(facts);
      }
    } else {
      unlinked.push(sighting);

      if (fromCatalog) {
        historySightings.push(sighting);
      }
    }
  }

  return { boardFacts, historySightings, jobs, stillListed, unlinked };
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
            departed: 0,
            error: failure.message,
            key: feed.key,
            source: feed.source,
            upserted: 0,
          })
        ),
      onSuccess: (postings) => {
        const { boardFacts, jobs, stillListed, unlinked, historySightings } =
          listingsFromPostings(feed, postings, seenAt);

        return store.recordSightings(historySightings, seenAt).pipe(
          Effect.andThen(store.markListed(feed.key, stillListed, seenAt)),
          Effect.andThen(store.replaceFeed(feed.key, jobs, seenAt)),
          Effect.tap(() => store.saveBoardFacts(boardFacts, seenAt)),
          Effect.tap(() => warnOfUnlinked(feed, unlinked)),
          Effect.map((replacement): FeedOutcomeValue => ({
            departed: replacement.departed,
            error: null,
            key: feed.key,
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

  const expired = yield* store.prune(retentionAt(startedAt));
  const finishedAt = yield* Clock.currentTimeMillis;

  const failed = pipe(
    outcomes,
    Array.filter((outcome) => outcome.error !== null)
  ).length;

  const receipt: IngestReceiptValue = {
    feedsAttempted: outcomes.length,
    feedsFailed: failed,
    finishedAt,
    jobsPruned: expired,
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
    () =>
      store
        .releaseIngest(startedAt)
        .pipe(
          Effect.catchTag("JobStoreUnavailable", ({ operation }) =>
            Effect.logWarning(
              "ingest lease release failed; lease will expire"
            ).pipe(Effect.annotateLogs({ operation, startedAt }))
          )
        )
  );
});
