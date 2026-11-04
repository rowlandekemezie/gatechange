import { Array, Effect, Layer, Option, pipe } from "effect";

import {
  companySlugOf,
  COMPANY_LISTING_ROWS,
  daysOpen,
  fingerprintOf,
  isRepost,
  JobStore,
  EVERY_POSTING,
  listingStatus,
  MAX_AGE_DAYS,
  paidFeaturesAllowed,
  sourceOfFeedKey,
  TREND_WINDOW_MILLIS,
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
  Stint,
} from "../src/index.js";

interface IntelHistory {
  readonly company: string;
  readonly feed: string;
  readonly firstSeenAt: number;
  readonly previous: Stint | null;
  readonly reposts: number;
  readonly stint: Stint;
}

export interface MemoryJobStore {
  readonly departed: () => ReadonlyMap<string, number>;
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

const noEnrichment: Omit<EnrichmentValue, "board" | "enrichedAt"> = {
  handsOn: null,
  model: null,
  promptVersion: null,
  remotePolicy: null,
  reportsTo: null,
  salary: null,
  seniority: null,
  teamSize: null,
};

const isAi = (enrichment: EnrichmentValue | undefined) =>
  (enrichment?.model ?? null) !== null;

const isCurrentAi = (
  enrichment: EnrichmentValue | undefined,
  promptVersion: number
) => isAi(enrichment) && (enrichment?.promptVersion ?? 1) >= promptVersion;

export const makeMemoryJobStore = Effect.sync((): MemoryJobStore => {
  const jobs = new Map<string, JobValue>();
  const departed = new Map<string, number>();
  const states = new Map<string, FeedStateValue>();
  const runs: IngestReceiptValue[] = [];
  const history = new Map<string, ListingHistory>();
  const enrichments = new Map<string, EnrichmentValue>();
  const skips = new Map<string, EnrichmentSkip>();

  const intel = new Map<string, IntelHistory>();
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

  const sightIntel = (job: Sighted, seenAt: number) => {
    if (
      !Option.exists(sourceOfFeedKey(job.feed), (source) =>
        paidFeaturesAllowed(source)
      )
    ) {
      return;
    }

    const fingerprint = JSON.stringify([
      Option.getOrNull(companySlugOf(job.company)),
      fingerprintOf(job),
    ]);

    const found = intel.get(fingerprint);

    if (found === undefined) {
      intel.set(fingerprint, {
        company: job.company,
        feed: job.feed,
        firstSeenAt: seenAt,
        previous: null,
        reposts: 0,
        stint: { from: seenAt, until: seenAt },
      });

      return;
    }

    const reopened = isRepost({
      lastSeenAt: found.stint.until,
      lastSeenFeedSuccessAt: successBefore(found.feed, seenAt),
      seenAt,
    });

    const newer =
      found.stint.until < seenAt ||
      (found.stint.until === seenAt && job.feed < found.feed);

    const stint = reopened ? { from: seenAt, until: seenAt } : found.stint;

    intel.set(fingerprint, {
      company: found.stint.until < seenAt ? job.company : found.company,
      feed: newer ? job.feed : found.feed,
      firstSeenAt: found.firstSeenAt,
      previous: reopened ? found.stint : found.previous,
      reposts: found.reposts + (reopened ? 1 : 0),
      stint: { from: stint.from, until: Math.max(stint.until, seenAt) },
    });
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
    companyJobs: (slug, now) =>
      Effect.sync(() => {
        const matching = [...jobs.values()]
          .flatMap((job) =>
            Option.contains(companySlugOf(job.company), slug) &&
            !departed.has(job.id) &&
            job.postedAt >= now - MAX_AGE_DAYS * 86_400_000
              ? [
                  {
                    ...job,
                    daysOpen: daysOpen(
                      history.get(fingerprintOf(job))?.firstSeenAt ??
                        job.firstSeenAt,
                      now
                    ),
                    enrichment: enrichmentOf(job.id),
                    reposts: history.get(fingerprintOf(job))?.reposts ?? 0,
                  },
                ]
              : []
          )
          .toSorted(
            (left, right) =>
              right.postedAt - left.postedAt || left.id.localeCompare(right.id)
          );

        let longestOpenDays = 0;

        for (const job of matching) {
          longestOpenDays = Math.max(longestOpenDays, job.daysOpen);
        }

        return {
          jobs: matching
            .slice(0, COMPANY_LISTING_ROWS)
            .map(
              ({ daysOpen: _daysOpen, reposts: _reposts, ...detail }) => detail
            ),
          summary: {
            longestOpenDays,
            openRoles: matching.length,
          },
          total: matching.length,
        };
      }),

    companyRecords: (slug, now) =>
      Effect.sync(() => ({
        history: [...intel.values()].flatMap((found) =>
          Option.contains(companySlugOf(found.company), slug) &&
          found.stint.until > now - TREND_WINDOW_MILLIS
            ? [
                {
                  company: found.company,
                  feed: found.feed,
                  stints:
                    found.previous === null
                      ? [found.stint]
                      : [found.stint, found.previous],
                },
              ]
            : []
        ),
        open: [...jobs.values()].flatMap((job) => {
          const found = intel.get(
            JSON.stringify([
              Option.getOrNull(companySlugOf(job.company)),
              fingerprintOf(job),
            ])
          );

          return Option.contains(companySlugOf(job.company), slug) &&
            !departed.has(job.id) &&
            job.postedAt >= now - MAX_AGE_DAYS * 86_400_000
            ? [
                {
                  company: job.company,
                  id: job.id,
                  openedAt: found?.stint.from ?? job.firstSeenAt,
                  reposts: found?.reposts ?? 0,
                  role: job.role,
                  salary: enrichmentOf(job.id)?.salary ?? null,
                  source: job.source,
                  title: job.title,
                },
              ]
            : [];
        }),
        trackedSince:
          intel.size === 0
            ? null
            : Math.min(
                ...[...intel.values()].map((found) => found.firstSeenAt)
              ),
      })),
    feedStates: Effect.sync(() => [...states.values()]),
    find: (id) =>
      Effect.sync(() =>
        pipe(
          Option.fromNullishOr(jobs.get(id)),
          Option.filter(() => !departed.has(id)),
          Option.map((job) => ({ ...job, enrichment: enrichmentOf(id) }))
        )
      ),
    findIncludingDeparted: (id) =>
      Effect.sync(() =>
        pipe(
          Option.fromNullishOr(jobs.get(id)),
          Option.map((job) => ({ ...job, enrichment: enrichmentOf(id) }))
        )
      ),
    heldListings: (feedKey, ids) =>
      Effect.sync(() => ids.filter((id) => jobs.get(id)?.feed === feedKey)),
    historyOf: (job) =>
      Effect.sync(() => Option.fromNullishOr(history.get(fingerprintOf(job)))),
    list: (query, now, sources) =>
      Effect.sync(() => {
        const matching = pipe(
          [...jobs.values()],
          Array.filter(
            (job) =>
              job.postedAt >= now - query.maxAgeDays * 86_400_000 &&
              !departed.has(job.id) &&
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
                status: listingStatus(
                  {
                    departedAt: departed.get(job.id) ?? null,
                    firstSeenAt: job.firstSeenAt,
                    postedAt: job.postedAt,
                  },
                  now
                ),
              };
            })
          ),
          total: matching.length,
        };
      }),
    markListed: (feedKey, ids, seenAt) =>
      Effect.sync(() => {
        for (const id of ids) {
          const job = jobs.get(id);

          if (job?.feed === feedKey) {
            jobs.set(id, {
              ...job,
              lastSeenAt: Math.max(job.lastSeenAt, seenAt),
            });
            departed.delete(id);
          }
        }
      }),
    neuronsClaimed: (day) => Effect.sync(() => neurons.get(day) ?? 0),
    prune: ({ departedBefore, unseenBefore }) =>
      Effect.sync(() => {
        const expired = pipe(
          [...jobs.values()],
          Array.filter(
            (job) =>
              (departed.get(job.id) ?? Number.POSITIVE_INFINITY) <
                departedBefore || job.lastSeenAt < unseenBefore
          )
        );

        for (const job of expired) {
          jobs.delete(job.id);
          departed.delete(job.id);
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
          sightIntel(listing, seenAt);
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
    replaceFeed: (
      feedKey,
      incoming,
      seenAt,
      departPostedBefore = EVERY_POSTING
    ) =>
      Effect.sync(() => {
        const stale = pipe(
          [...jobs.values()],
          Array.filter(
            (job) =>
              job.feed === feedKey &&
              job.lastSeenAt < seenAt &&
              job.postedAt < departPostedBefore &&
              !departed.has(job.id) &&
              !pipe(
                incoming,
                Array.some((next) => next.id === job.id)
              )
          )
        );

        for (const job of incoming) {
          sight(job, seenAt);
          sightIntel(job, seenAt);

          const existing = Option.fromNullishOr(jobs.get(job.id));

          jobs.set(job.id, {
            ...job,
            firstSeenAt: Option.match(existing, {
              onNone: () => job.firstSeenAt,
              onSome: (found) => found.firstSeenAt,
            }),
            lastSeenAt: Option.match(existing, {
              onNone: () => job.lastSeenAt,
              onSome: (found) => Math.max(found.lastSeenAt, job.lastSeenAt),
            }),
            postedAt: Option.match(existing, {
              onNone: () => job.postedAt,
              onSome: (found) => Math.min(found.postedAt, job.postedAt),
            }),
          });
          departed.delete(job.id);
        }

        for (const job of stale) {
          departed.set(job.id, seenAt);
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

        return { departed: stale.length, upserted: incoming.length };
      }),
    saveBoardFacts: (rows, seenAt) =>
      Effect.sync(() => {
        for (const { board, facts, id } of rows) {
          const existing = enrichments.get(id) ?? {
            ...noEnrichment,
            enrichedAt: seenAt,
          };

          enrichments.set(id, {
            ...existing,
            board,
            remotePolicy: facts.remotePolicy ?? existing.remotePolicy,
            salary: facts.salary ?? existing.salary,
            seniority: facts.seniority ?? existing.seniority,
          });
        }
      }),
    saveEnrichment: (id, enrichment) =>
      Effect.sync(() => {
        enrichments.set(id, enrichment);
        skips.delete(id);
      }),
    sitemapJobs: (_now, sources) =>
      Effect.sync(() =>
        [...jobs.values()].flatMap((job) =>
          sources.includes(job.source) && !departed.has(job.id)
            ? [
                {
                  company: job.company,
                  firstSeenAt: job.firstSeenAt,
                  id: job.id,
                  region: job.region,
                  role: job.role,
                },
              ]
            : []
        )
      ),
    stats: (_now, sources, catalogKeys) =>
      Effect.sync(() => ({
        activeJobs: [...jobs.values()].filter(
          (job) => sources.includes(job.source) && !departed.has(job.id)
        ).length,
        companies: [],
        feedsFailing: pipe(
          [...states.values()],
          Array.filter(
            (state) =>
              catalogKeys.includes(state.key) && state.consecutiveFailures > 0
          )
        ).length,
        feedsTotal: [...states.keys()].filter((key) =>
          catalogKeys.includes(key)
        ).length,
        lastRun: Option.getOrNull(Array.last(runs)),
        newToday: 0,
        placements: [],
        regions: [],
        roles: [],
      })),
    unenrichedListings: ({
      finalSkips,
      limit,
      promptVersion,
      since,
      sources,
    }) =>
      Effect.sync(() =>
        pipe(
          [...jobs.values()],
          Array.filter((job) => {
            const skip = skips.get(job.id);

            return (
              job.firstSeenAt >= since &&
              !departed.has(job.id) &&
              sources.includes(job.source) &&
              !isCurrentAi(enrichments.get(job.id), promptVersion) &&
              (skip === undefined || !finalSkips.includes(skip.reason))
            );
          }),
          (found) =>
            found.toSorted(
              (left, right) =>
                Number(skips.has(left.id)) - Number(skips.has(right.id)) ||
                Number(isAi(enrichments.get(left.id))) -
                  Number(isAi(enrichments.get(right.id))) ||
                right.firstSeenAt - left.firstSeenAt ||
                left.id.localeCompare(right.id)
            ),
          Array.take(limit),
          Array.map((job) => job.id)
        )
      ),
  });

  return {
    departed: () => departed,
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
