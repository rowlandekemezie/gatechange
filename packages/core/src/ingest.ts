import { Array, Clock, Effect, pipe } from "effect";

import { selectDueFeeds } from "./feed.js";
import type { FeedOutcome, FeedRef } from "./feed.js";
import { MAX_AGE_DAYS } from "./job.js";
import type { IngestReceipt, Job } from "./job.js";
import { JobStore } from "./job-store.js";
import { DAY_MILLIS, normalizePosting } from "./posting.js";
import type { Posting } from "./posting.js";
import { PostingFeeds } from "./posting-feeds.js";

export interface IngestPlan {
  readonly feedConcurrency: number;
  readonly feedsPerRun: number;
}

export const retentionCutoff = (now: number) => now - MAX_AGE_DAYS * DAY_MILLIS;

export const jobsFromPostings = (
  feed: FeedRef,
  postings: ReadonlyArray<Posting>,
  seenAt: number
): ReadonlyArray<Job> =>
  pipe(
    postings,
    Array.map((posting) => normalizePosting(feed, posting, seenAt)),
    Array.getSomes,
    Array.filter((job) => job.postedAt >= retentionCutoff(seenAt)),
    Array.dedupeWith((left, right) => left.id === right.id)
  );

const ingestFeed = Effect.fn("ingestFeed")(function* ingestFeed(feed: FeedRef, seenAt: number) {
  const store = yield* JobStore;
  const feeds = yield* PostingFeeds;

  return yield* feeds.fetch(feed).pipe(
    Effect.matchEffect({
      onFailure: (failure) =>
        store.recordFeedFailure(feed.key, seenAt, failure.message).pipe(
          Effect.as<FeedOutcome>({
            error: failure.message,
            key: feed.key,
            pruned: 0,
            source: feed.source,
            upserted: 0,
          })
        ),
      onSuccess: (postings) =>
        store.replaceFeed(feed.key, jobsFromPostings(feed, postings, seenAt), seenAt).pipe(
          Effect.map(
            (replacement): FeedOutcome => ({
              error: null,
              key: feed.key,
              pruned: replacement.removed,
              source: feed.source,
              upserted: replacement.upserted,
            })
          )
        ),
    })
  );
});

const outcomeOf = (attempted: number, failed: number): IngestReceipt["outcome"] => {
  if (failed === 0) {
    return "Succeeded";
  }

  if (failed === attempted) {
    return "Failed";
  }

  return "Partial";
};

export const runIngest = Effect.fn("runIngest")(function* runIngest(plan: IngestPlan) {
  const store = yield* JobStore;
  const feeds = yield* PostingFeeds;
  const startedAt = yield* Clock.currentTimeMillis;
  const states = yield* store.feedStates;
  const due = selectDueFeeds(feeds.catalog, states, startedAt, plan.feedsPerRun);

  const outcomes = yield* Effect.forEach(due, (feed) => ingestFeed(feed, startedAt), {
    concurrency: plan.feedConcurrency,
  });

  const expired = yield* store.pruneOlderThan(retentionCutoff(startedAt));
  const finishedAt = yield* Clock.currentTimeMillis;
  const failed = Array.filter(outcomes, (outcome) => outcome.error !== null).length;

  const receipt: IngestReceipt = {
    feedsAttempted: outcomes.length,
    feedsFailed: failed,
    finishedAt,
    jobsPruned: expired + Array.reduce(outcomes, 0, (total, outcome) => total + outcome.pruned),
    jobsUpserted: Array.reduce(outcomes, 0, (total, outcome) => total + outcome.upserted),
    outcome: outcomeOf(outcomes.length, failed),
    startedAt,
  };

  yield* store.recordRun(receipt);

  return { outcomes, receipt };
});
