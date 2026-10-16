import { Array, Effect, Layer, Option, pipe } from "effect";

import { JobStore } from "../src/index.js";
import type { FeedStateValue, IngestReceiptValue, JobValue } from "../src/index.js";

export interface MemoryJobStore {
  readonly feedStates: () => readonly FeedStateValue[];
  readonly jobs: () => readonly JobValue[];
  readonly layer: Layer.Layer<JobStore>;
  readonly runs: () => readonly IngestReceiptValue[];
}

export const makeMemoryJobStore = Effect.sync((): MemoryJobStore => {
  const jobs = new Map<string, JobValue>();
  const states = new Map<string, FeedStateValue>();
  const runs: IngestReceiptValue[] = [];

  const stateOf = (key: string): FeedStateValue =>
    states.get(key) ?? {
      consecutiveFailures: 0,
      key,
      lastAttemptAt: null,
      lastError: null,
      lastSuccessAt: null,
    };

  const store = JobStore.of({
    feedStates: Effect.sync(() => [...states.values()]),
    list: (query, now) =>
      Effect.sync(() => {
        const matching = pipe(
          [...jobs.values()],
          Array.filter((job) => job.postedAt >= now - query.maxAgeDays * 86_400_000)
        );

        return {
          jobs: Array.take(matching, query.limit),
          total: matching.length,
        };
      }),
    pruneOlderThan: (cutoff) =>
      Effect.sync(() => {
        const expired = pipe([...jobs.values()], Array.filter((job) => job.postedAt < cutoff));

        for (const job of expired) {
          jobs.delete(job.id);
        }

        return expired.length;
      }),
    recordFeedFailure: (feedKey, attemptedAt, message) =>
      Effect.sync(() => {
        const previous = stateOf(feedKey);

        states.set(feedKey, {
          ...previous,
          consecutiveFailures: previous.consecutiveFailures + 1,
          lastAttemptAt: attemptedAt,
          lastError: message,
        });
      }),
    recordRun: (receipt) =>
      Effect.sync(() => {
        runs.push(receipt);
      }),
    replaceFeed: (feedKey, incoming, seenAt) =>
      Effect.sync(() => {
        const stale = pipe([...jobs.values()], Array.filter((job) => job.feed === feedKey && !pipe(incoming, Array.some((next) => next.id === job.id))));

        for (const job of stale) {
          jobs.delete(job.id);
        }

        for (const job of incoming) {
          const existing = Option.fromNullishOr(jobs.get(job.id));

          jobs.set(job.id, {
            ...job,
            firstSeenAt: Option.match(existing, {
              onNone: () => job.firstSeenAt,
              onSome: (found) => found.firstSeenAt,
            }),
            postedAt: Option.match(existing, {
              onNone: () => job.postedAt,
              onSome: (found) => Math.min(found.postedAt, job.postedAt),
            }),
          });
        }

        states.set(feedKey, {
          consecutiveFailures: 0,
          key: feedKey,
          lastAttemptAt: seenAt,
          lastError: null,
          lastSuccessAt: seenAt,
        });

        return { removed: stale.length, upserted: incoming.length };
      }),
    stats: () =>
      Effect.sync(() => ({
        activeJobs: jobs.size,
        feedsFailing: pipe([...states.values()], Array.filter((state) => state.consecutiveFailures > 0))
          .length,
        feedsTotal: states.size,
        lastRun: Option.getOrNull(Array.last(runs)),
        newToday: 0,
        regions: [],
        roles: [],
      })),
  });

  return {
    feedStates: () => [...states.values()],
    jobs: () => [...jobs.values()],
    layer: Layer.succeed(JobStore, store),
    runs: () => runs,
  };
});

