import { Array, Effect, Layer, Option, pipe } from "effect";

import { daysOpen, fingerprintOf, isRepost, JobStore } from "../src/index.js";
import type {
  FeedStateValue,
  IngestReceiptValue,
  JobValue,
  ListingHistory,
} from "../src/index.js";

export interface MemoryJobStore {
  readonly feedStates: () => readonly FeedStateValue[];
  readonly history: () => ReadonlyMap<string, ListingHistory>;
  readonly jobs: () => readonly JobValue[];
  readonly layer: Layer.Layer<JobStore>;
  readonly runs: () => readonly IngestReceiptValue[];
}

export const makeMemoryJobStore = Effect.sync((): MemoryJobStore => {
  const jobs = new Map<string, JobValue>();
  const states = new Map<string, FeedStateValue>();
  const runs: IngestReceiptValue[] = [];
  const history = new Map<string, ListingHistory>();

  const lastSeenFeeds = new Map<string, string>();
  const previousSuccesses = new Map<string, number | null>();

  const successBefore = (feedKey: string, seenAt: number) => {
    const latest = states.get(feedKey)?.lastSuccessAt ?? null;
    const previous = previousSuccesses.get(feedKey) ?? null;

    if (latest !== null && latest < seenAt) {
      return latest;
    }

    return previous !== null && previous < seenAt ? previous : null;
  };

  const sight = (job: JobValue, seenAt: number) => {
    const fingerprint = fingerprintOf(job);
    const previous = Option.fromNullishOr(history.get(fingerprint));
    const lastSeenFeed = lastSeenFeeds.get(fingerprint) ?? job.feed;

    history.set(
      fingerprint,
      Option.match(previous, {
        onNone: () => ({
          firstSeenAt: seenAt,
          lastSeenAt: seenAt,
          reposts: 0,
          sightings: 1,
        }),
        onSome: (found) => ({
          firstSeenAt: Math.min(found.firstSeenAt, seenAt),
          lastSeenAt: Math.max(found.lastSeenAt, seenAt),
          reposts:
            found.reposts +
            (isRepost({
              lastSeenAt: found.lastSeenAt,
              lastSeenFeedSuccessAt: successBefore(lastSeenFeed, seenAt),
              seenAt,
            })
              ? 1
              : 0),
          sightings: found.sightings + (found.lastSeenAt < seenAt ? 1 : 0),
        }),
      })
    );

    const lastSeenAt = Option.match(previous, {
      onNone: () => Number.NEGATIVE_INFINITY,
      onSome: (found) => found.lastSeenAt,
    });

    if (
      lastSeenAt < seenAt ||
      (lastSeenAt === seenAt && job.feed < lastSeenFeed)
    ) {
      lastSeenFeeds.set(fingerprint, job.feed);
    }
  };

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
    historyOf: (job) =>
      Effect.sync(() => Option.fromNullishOr(history.get(fingerprintOf(job)))),
    list: (query, now) =>
      Effect.sync(() => {
        const matching = pipe(
          [...jobs.values()],
          Array.filter(
            (job) => job.postedAt >= now - query.maxAgeDays * 86_400_000
          )
        );

        return {
          jobs: pipe(
            Array.take(matching, query.limit),
            Array.map((job) => {
              const found = history.get(fingerprintOf(job));

              return {
                ...job,
                daysOpen: daysOpen(found?.firstSeenAt ?? job.firstSeenAt, now),
                reposts: found?.reposts ?? 0,
              };
            })
          ),
          total: matching.length,
        };
      }),
    pruneOlderThan: (cutoff) =>
      Effect.sync(() => {
        const expired = pipe(
          [...jobs.values()],
          Array.filter((job) => job.postedAt < cutoff)
        );

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
          lastAttemptAt: Math.max(previous.lastAttemptAt ?? 0, attemptedAt),
          lastError: message,
        });
      }),
    recordRun: (receipt) =>
      Effect.sync(() => {
        runs.push(receipt);
      }),
    replaceFeed: (feedKey, incoming, seenAt) =>
      Effect.sync(() => {
        const stale = pipe(
          [...jobs.values()],
          Array.filter(
            (job) =>
              job.feed === feedKey &&
              !pipe(
                incoming,
                Array.some((next) => next.id === job.id)
              )
          )
        );

        for (const job of incoming) {
          sight(job, seenAt);

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

        for (const job of stale) {
          jobs.delete(job.id);
        }

        const previous = stateOf(feedKey);
        const lastSuccessAt = previous.lastSuccessAt ?? 0;

        if (lastSuccessAt < seenAt) {
          previousSuccesses.set(feedKey, previous.lastSuccessAt);
        }

        states.set(feedKey, {
          consecutiveFailures: 0,
          key: feedKey,
          lastAttemptAt: Math.max(previous.lastAttemptAt ?? 0, seenAt),
          lastError: null,
          lastSuccessAt: Math.max(lastSuccessAt, seenAt),
        });

        return { removed: stale.length, upserted: incoming.length };
      }),
    stats: () =>
      Effect.sync(() => ({
        activeJobs: jobs.size,
        feedsFailing: pipe(
          [...states.values()],
          Array.filter((state) => state.consecutiveFailures > 0)
        ).length,
        feedsTotal: states.size,
        lastRun: Option.getOrNull(Array.last(runs)),
        newToday: 0,
        regions: [],
        roles: [],
      })),
  });

  return {
    feedStates: () => [...states.values()],
    history: () => history,
    jobs: () => [...jobs.values()],
    layer: Layer.succeed(JobStore, store),
    runs: () => runs,
  };
});
