import { Array, Clock, Effect, Option, pipe, Schema } from "effect";

import { boardFactsOf } from "./board-facts.js";
import type { BoardFactsRow } from "./board-facts.js";
import { selectDueFeeds } from "./feed.js";
import type { FeedOutcomeValue, FeedRef } from "./feed.js";
import { JobStore } from "./job-store.js";
import type { Sighted } from "./job-store.js";
import { ADMISSION_DAYS } from "./job.js";
import type { IngestReceiptValue, JobValue } from "./job.js";
import { coverageRules, retentionAt } from "./listing-status.js";
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

export const admissionCutoff = (now: number) =>
  now - ADMISSION_DAYS * DAY_MILLIS;

export interface LongOpenListing {
  readonly facts: BoardFactsRow | null;
  readonly job: JobValue;
}

export interface FeedListings {
  readonly boardFacts: readonly BoardFactsRow[];
  readonly jobs: readonly JobValue[];
  readonly longOpen: readonly LongOpenListing[];
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
  const longOpen: LongOpenListing[] = [];
  const stillListed: string[] = [];
  const unlinked: Sighted[] = [];
  const historySightings: Sighted[] = [];

  for (const { listing, fromCatalog, posting } of listings) {
    const { url, ...sighting } = listing;

    if (listing.postedAt < admissionCutoff(seenAt)) {
      stillListed.push(listing.id);

      if (Option.isSome(url) && coverageRules[feed.coverage].admitsLongOpen) {
        longOpen.push({
          facts: boardFactsOf(listing, posting),
          job: { ...sighting, url: url.value },
        });
      }
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

  return {
    boardFacts,
    historySightings,
    jobs,
    longOpen,
    stillListed,
    unlinked,
  };
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

  const failedFeed = (message: string) =>
    store.recordFeedFailure(feed.key, seenAt, message).pipe(
      Effect.catchTag("JobStoreUnavailable", ({ operation }) =>
        Effect.logWarning("could not record a feed failure").pipe(
          Effect.annotateLogs({ feed: feed.key, operation })
        )
      ),
      Effect.as<FeedOutcomeValue>({
        departed: 0,
        error: message,
        key: feed.key,
        source: feed.source,
        upserted: 0,
      })
    );

  return yield* feeds.fetch(feed).pipe(
    Effect.matchEffect({
      onFailure: ({ message }) => failedFeed(message),
      onSuccess: (postings) =>
        Effect.gen(function* recordListings() {
          const listings = listingsFromPostings(feed, postings, seenAt);

          const held = yield* store.heldListings(
            feed.key,
            listings.longOpen.map(({ job }) => job.id)
          );

          const admitted = listings.longOpen.filter(
            ({ job }) => !held.includes(job.id)
          );

          yield* store.recordSightings(listings.historySightings, seenAt);
          yield* store.markListed(feed.key, listings.stillListed, seenAt);

          const replacement = yield* store.replaceFeed(
            feed.key,
            [...listings.jobs, ...admitted.map(({ job }) => job)],
            seenAt,
            coverageRules[feed.coverage].departPostedBefore(seenAt)
          );

          yield* store.saveBoardFacts(
            [
              ...listings.boardFacts,
              ...admitted.flatMap(({ facts }) =>
                facts === null ? [] : [facts]
              ),
            ],
            seenAt
          );
          yield* warnOfUnlinked(feed, listings.unlinked);

          return {
            departed: replacement.departed,
            error: null,
            key: feed.key,
            source: feed.source,
            upserted: replacement.upserted,
          } satisfies FeedOutcomeValue;
        }).pipe(
          Effect.catchTag("JobStoreUnavailable", ({ message }) =>
            failedFeed(message)
          )
        ),
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
