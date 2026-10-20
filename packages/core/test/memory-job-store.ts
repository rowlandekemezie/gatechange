import { Array, Effect, Layer, Option, pipe } from "effect";

import {
  daysOpen,
  fingerprintOf,
  isRepost,
  JobStore,
  paidFeaturesAllowed,
} from "../src/index.js";
import type {
  EnrichmentSkip,
  EnrichmentValue,
  FeedStateValue,
  IngestReceiptValue,
  JobQueryValue,
  JobValue,
  ListingHistory,
  Sighted,
} from "../src/index.js";

export interface MemoryJobStore {
  readonly enrichments: () => ReadonlyMap<string, EnrichmentValue>;
  readonly feedStates: () => readonly FeedStateValue[];
  readonly history: () => ReadonlyMap<string, ListingHistory>;
  readonly jobs: () => readonly JobValue[];
  readonly layer: Layer.Layer<JobStore>;
  readonly neurons: () => ReadonlyMap<number, number>;
  readonly neuronsUsed: () => ReadonlyMap<number, number>;
  readonly runs: () => readonly IngestReceiptValue[];
  readonly skips: () => ReadonlyMap<string, EnrichmentSkip>;
}

export const makeMemoryJobStore = Effect.sync((): MemoryJobStore => {
  const jobs = new Map<string, JobValue>();
  const states = new Map<string, FeedStateValue>();
  const runs: IngestReceiptValue[] = [];
  const history = new Map<string, ListingHistory>();
  const enrichments = new Map<string, EnrichmentValue>();
  const skips = new Map<string, EnrichmentSkip>();

  const lastSeenFeeds = new Map<string, string>();
  const previousSuccesses = new Map<string, number | null>();
  const lease = { heldUntil: 0, startedAt: 0 };
  const neurons = new Map<number, number>();
  const neuronsUsed = new Map<number, number>();

  const successBefore = (feedKey: string, seenAt: number) => {
    const latest = states.get(feedKey)?.lastSuccessAt ?? null;
    const previous = previousSuccesses.get(feedKey) ?? null;

    if (latest !== null && latest < seenAt) {
      return latest;
    }

    return previous !== null && previous < seenAt ? previous : null;
  };

  const sight = (job: Sighted, seenAt: number) => {
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

  const enrichmentOf = (id: string) => enrichments.get(id) ?? null;

  const matchesEnrichment = (query: JobQueryValue) => (job: JobValue) => {
    const salary = enrichmentOf(job.id)?.salary ?? null;
    const seniority = enrichmentOf(job.id)?.seniority ?? null;
    const { salaryFloor } = query;

    const salaryMatches =
      salaryFloor === null ||
      (salary?.currency === salaryFloor.currency &&
        salary.max >= salaryFloor.amount);

    const seniorityMatches =
      query.seniorities.length === 0 ||
      (seniority !== null && query.seniorities.includes(seniority));

    const listedMatches =
      !query.salaryListed ||
      ((job.salary !== null || salary !== null) &&
        paidFeaturesAllowed(job.source));

    return salaryMatches && seniorityMatches && listedMatches;
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
    claimIngest: (startedAt, heldUntil) =>
      Effect.sync(() => {
        if (lease.heldUntil > startedAt) {
          return false;
        }

        lease.startedAt = startedAt;
        lease.heldUntil = heldUntil;

        return true;
      }),
    claimNeurons: (claim) =>
      Effect.sync(() => {
        const claimed = neurons.get(claim.day) ?? 0;

        if (claimed + claim.neurons > claim.budget) {
          return false;
        }

        neurons.set(claim.day, claimed + claim.neurons);

        return true;
      }),
    feedStates: Effect.sync(() => [...states.values()]),
    find: (id) =>
      Effect.sync(() =>
        pipe(
          Option.fromNullishOr(jobs.get(id)),
          Option.map((job) => ({ ...job, enrichment: enrichmentOf(id) }))
        )
      ),
    historyOf: (job) =>
      Effect.sync(() => Option.fromNullishOr(history.get(fingerprintOf(job)))),
    list: (query, now, sources) =>
      Effect.sync(() => {
        const matching = pipe(
          [...jobs.values()],
          Array.filter(
            (job) =>
              job.postedAt >= now - query.maxAgeDays * 86_400_000 &&
              sources.includes(job.source)
          ),
          Array.filter(matchesEnrichment(query))
        );

        return {
          jobs: pipe(
            Array.take(matching, query.limit),
            Array.map((job) => {
              const found = history.get(fingerprintOf(job));

              return {
                ...job,
                daysOpen: daysOpen(found?.firstSeenAt ?? job.firstSeenAt, now),
                enrichment: enrichmentOf(job.id),
                reposts: found?.reposts ?? 0,
              };
            })
          ),
          total: matching.length,
        };
      }),
    neuronsClaimed: (day) => Effect.sync(() => neurons.get(day) ?? 0),
    pruneOlderThan: (cutoff) =>
      Effect.sync(() => {
        const expired = pipe(
          [...jobs.values()],
          Array.filter((job) => job.postedAt < cutoff)
        );

        for (const job of expired) {
          jobs.delete(job.id);
        }

        for (const kept of [enrichments, skips]) {
          for (const id of kept.keys()) {
            if (!jobs.has(id)) {
              kept.delete(id);
            }
          }
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
    recordNeuronsUsed: (usage) =>
      Effect.sync(() => {
        if (usage.neurons < 0) {
          return;
        }

        neuronsUsed.set(
          usage.day,
          (neuronsUsed.get(usage.day) ?? 0) + usage.neurons
        );
        neurons.set(
          usage.day,
          Math.max(
            0,
            (neurons.get(usage.day) ?? 0) + usage.neurons - usage.claimed
          )
        );
      }),
    recordRun: (receipt) =>
      Effect.sync(() => {
        runs.push(receipt);
      }),
    recordSightings: (listings, seenAt) =>
      Effect.sync(() => {
        for (const listing of listings) {
          sight(listing, seenAt);
        }
      }),
    recordSkip: (id, skip) =>
      Effect.sync(() => {
        skips.set(id, skip);
      }),
    releaseIngest: (startedAt) =>
      Effect.sync(() => {
        if (lease.startedAt === startedAt) {
          lease.heldUntil = startedAt;
        }
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

        if (
          previous.lastSuccessAt !== null &&
          previous.lastSuccessAt !== seenAt
        ) {
          const below = Math.min(previous.lastSuccessAt, seenAt);

          previousSuccesses.set(
            feedKey,
            Math.max(previousSuccesses.get(feedKey) ?? below, below)
          );
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
    saveEnrichment: (id, enrichment) =>
      Effect.sync(() => {
        enrichments.set(id, enrichment);
        skips.delete(id);
      }),
    stats: (_now, sources) =>
      Effect.sync(() => ({
        activeJobs: [...jobs.values()].filter((job) =>
          sources.includes(job.source)
        ).length,
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
    unenrichedListings: ({ finalSkips, limit, since, sources }) =>
      Effect.sync(() =>
        pipe(
          [...jobs.values()],
          Array.filter((job) => {
            const skip = skips.get(job.id);

            return (
              job.firstSeenAt >= since &&
              sources.includes(job.source) &&
              !enrichments.has(job.id) &&
              (skip === undefined || !finalSkips.includes(skip.reason))
            );
          }),
          (found) =>
            found.toSorted(
              (left, right) =>
                Number(skips.has(left.id)) - Number(skips.has(right.id)) ||
                right.firstSeenAt - left.firstSeenAt ||
                left.id.localeCompare(right.id)
            ),
          Array.take(limit),
          Array.map((job) => job.id)
        )
      ),
  });

  return {
    enrichments: () => enrichments,
    feedStates: () => [...states.values()],
    history: () => history,
    jobs: () => [...jobs.values()],
    layer: Layer.succeed(JobStore, store),
    neurons: () => neurons,
    neuronsUsed: () => neuronsUsed,
    runs: () => runs,
    skips: () => skips,
  };
});
