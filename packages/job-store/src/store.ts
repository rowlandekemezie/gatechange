import {
  Arrangement,
  Currency,
  daysOpen,
  Enrichment,
  IngestOutcome,
  JobStore,
  JobStoreUnavailable,
  Region,
  RoleLevel,
  SourceName,
  TREND_WINDOW_MILLIS,
} from "@rat-stack/core";
import type {
  EnrichmentValue,
  FeedStateValue,
  IngestReceiptValue,
  JobDetailValue,
  JobValue,
  ListedJobValue,
  ListingHistory,
  OpenRoleRecord,
} from "@rat-stack/core";
import { Array, Effect, Layer, Option, pipe, Schema } from "effect";

import {
  activeCountStatement,
  claimIngestStatement,
  claimNeuronsStatement,
  clearSkipStatement,
  companyHistoryStatement,
  companyOpenRolesStatement,
  countJobsStatement,
  feedFailedStatement,
  feedHealthStatement,
  feedStatesStatement,
  feedSucceededStatement,
  findJobStatement,
  historyStatement,
  lastRunStatement,
  listJobsStatement,
  newTodayStatement,
  pruneJobsStatement,
  neuronsClaimedStatement,
  pruneNeuronsStatement,
  pruneOrphanEnrichmentStatement,
  pruneOrphanSkipStatement,
  pruneRunsStatement,
  recordNeuronsUsedStatement,
  recordRunStatement,
  recordSkipStatement,
  regionCountsStatement,
  releaseIngestStatement,
  removeUnseenStatement,
  roleCountsStatement,
  saveEnrichmentStatement,
  sightingStatement,
  trackedSinceStatement,
  unenrichedListingsStatement,
  UPSERT_CHUNK,
  upsertJobStatement,
} from "./queries.js";
import { SqlExecutor } from "./sql-executor.js";

const Count = Schema.Finite;

export const JobRow = Schema.Struct({
  arrangement: Arrangement,
  company: Schema.String,
  feed: Schema.String,
  first_seen_at: Count,
  id: Schema.String,
  last_seen_at: Count,
  location: Schema.String,
  posted_at: Count,
  region: Region,
  relevance: Schema.Finite,
  role: RoleLevel,
  salary: Schema.NullOr(Schema.String),
  source: SourceName,
  title: Schema.String,
  url: Schema.String,
});

const EnrichedJobRow = Schema.Struct({
  ...JobRow.fields,
  enriched_at: Schema.NullOr(Count),
  model: Schema.NullOr(Schema.String),
  remote_policy: Schema.NullOr(Schema.String),
  reports_to: Schema.NullOr(Schema.String),
  salary_currency: Schema.NullOr(Schema.String),
  salary_max: Schema.NullOr(Count),
  salary_min: Schema.NullOr(Count),
  seniority: Schema.NullOr(Schema.String),
  team_size: Schema.NullOr(Count),
});

type EnrichedJobRowValue = typeof EnrichedJobRow.Type;

const ListedJobRow = Schema.Struct({
  ...EnrichedJobRow.fields,
  opened_at: Count,
  reposts: Count,
});

const IdRow = Schema.Struct({ id: Schema.String });

const TotalRow = Schema.Struct({ total: Count });

const HistoryRow = Schema.Struct({
  first_seen_at: Count,
  last_seen_at: Count,
  reposts: Count,
  sightings: Count,
});

const CompanyRoleRow = Schema.Struct({
  company: Schema.String,
  id: Schema.String,
  opened_at: Count,
  reposts: Count,
  role: RoleLevel,
  salary_currency: Schema.NullOr(Currency),
  salary_max: Schema.NullOr(Count),
  salary_min: Schema.NullOr(Count),
  source: SourceName,
  title: Schema.String,
});

const CompanyHistoryRow = Schema.Struct({
  first_seen_at: Count,
  last_seen_at: Count,
  last_seen_feed: Schema.String,
});

const TrackedSinceRow = Schema.Struct({ since: Schema.NullOr(Count) });

const openRoleOfRow = (row: typeof CompanyRoleRow.Type): OpenRoleRecord => ({
  company: row.company,
  id: row.id,
  openedAt: row.opened_at,
  reposts: row.reposts,
  role: row.role,
  salary:
    row.salary_currency === null ||
    row.salary_min === null ||
    row.salary_max === null
      ? null
      : {
          currency: row.salary_currency,
          max: row.salary_max,
          min: row.salary_min,
        },
  source: row.source,
  title: row.title,
});

const FeedStateRow = Schema.Struct({
  consecutive_failures: Count,
  key: Schema.String,
  last_attempt_at: Schema.NullOr(Count),
  last_error: Schema.NullOr(Schema.String),
  last_success_at: Schema.NullOr(Count),
});

const RegionCountRow = Schema.Struct({ count: Count, region: Region });

const RoleCountRow = Schema.Struct({ count: Count, role: RoleLevel });

const FeedHealthRow = Schema.Struct({ failing: Count, total: Count });

const RunRow = Schema.Struct({
  feeds_attempted: Count,
  feeds_failed: Count,
  finished_at: Count,
  jobs_pruned: Count,
  jobs_upserted: Count,
  outcome: IngestOutcome,
  started_at: Count,
});

export const jobOfRow = (row: typeof JobRow.Type): JobValue => ({
  arrangement: row.arrangement,
  company: row.company,
  feed: row.feed,
  firstSeenAt: row.first_seen_at,
  id: row.id,
  lastSeenAt: row.last_seen_at,
  location: row.location,
  postedAt: row.posted_at,
  region: row.region,
  relevance: row.relevance,
  role: row.role,
  salary: row.salary,
  source: row.source,
  title: row.title,
  url: row.url,
});

const decodeEnrichment = Schema.decodeUnknownEffect(Schema.NullOr(Enrichment));

const enrichmentOfRow = (
  operation: string,
  row: EnrichedJobRowValue
): Effect.Effect<EnrichmentValue | null, JobStoreUnavailable> =>
  decodeEnrichment(
    row.model === null
      ? null
      : {
          enrichedAt: row.enriched_at,
          model: row.model,
          remotePolicy: row.remote_policy,
          reportsTo: row.reports_to,
          salary:
            row.salary_currency === null
              ? null
              : {
                  currency: row.salary_currency,
                  max: row.salary_max,
                  min: row.salary_min,
                },
          seniority: row.seniority,
          teamSize: row.team_size,
        }
  ).pipe(
    Effect.mapError(
      (failure) =>
        new JobStoreUnavailable({
          message:
            `The job store holds an unreadable enrichment for ${row.id}: ${failure.message}`.slice(
              0,
              500
            ),
          operation,
        })
    )
  );

const jobDetailOfRow = (operation: string) => (row: EnrichedJobRowValue) =>
  enrichmentOfRow(operation, row).pipe(
    Effect.map((enrichment): JobDetailValue => ({
      ...jobOfRow(row),
      enrichment,
    }))
  );

const listedJobOfRow = (now: number) => (row: typeof ListedJobRow.Type) =>
  jobDetailOfRow("listJobs")(row).pipe(
    Effect.map((detail): ListedJobValue => ({
      ...detail,
      daysOpen: daysOpen(row.opened_at, now),
      reposts: row.reposts,
    }))
  );

const historyOfRow = (row: typeof HistoryRow.Type): ListingHistory => ({
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
  reposts: row.reposts,
  sightings: row.sightings,
});

const feedStateOfRow = (row: typeof FeedStateRow.Type): FeedStateValue => ({
  consecutiveFailures: row.consecutive_failures,
  key: row.key,
  lastAttemptAt: row.last_attempt_at,
  lastError: row.last_error,
  lastSuccessAt: row.last_success_at,
});

const receiptOfRow = (row: typeof RunRow.Type): IngestReceiptValue => ({
  feedsAttempted: row.feeds_attempted,
  feedsFailed: row.feeds_failed,
  finishedAt: row.finished_at,
  jobsPruned: row.jobs_pruned,
  jobsUpserted: row.jobs_upserted,
  outcome: row.outcome,
  startedAt: row.started_at,
});

const totalOf = (rows: readonly (typeof TotalRow.Type)[]) =>
  Option.match(Array.head(rows), {
    onNone: () => 0,
    onSome: (row) => row.total,
  });

export const makeJobStore = Effect.gen(function* makeJobStore() {
  const sql = yield* SqlExecutor;

  return JobStore.of({
    claimIngest: (startedAt, heldUntil) =>
      sql
        .batch("claimIngest", [claimIngestStatement(startedAt, heldUntil)])
        .pipe(Effect.map(([claim]) => claim?.changes === 1)),

    claimNeurons: (claim) =>
      sql
        .batch("claimNeurons", [claimNeuronsStatement(claim)])
        .pipe(Effect.map(([claimed]) => claimed?.changes === 1)),

    companyRecords: (slug, now) =>
      Effect.all(
        {
          history: sql.all(
            "companyHistory",
            companyHistoryStatement(slug, now - TREND_WINDOW_MILLIS),
            CompanyHistoryRow
          ),
          open: sql.all(
            "companyOpenRoles",
            companyOpenRolesStatement(slug, now),
            CompanyRoleRow
          ),
          tracked: sql.all(
            "trackedSince",
            trackedSinceStatement,
            TrackedSinceRow
          ),
        },
        { concurrency: 3 }
      ).pipe(
        Effect.map(({ history, open, tracked }) => ({
          history: history.map((row) => ({
            feed: row.last_seen_feed,
            firstSeenAt: row.first_seen_at,
            lastSeenAt: row.last_seen_at,
          })),
          open: open.map(openRoleOfRow),
          trackedSince: Option.match(Array.head(tracked), {
            onNone: () => null,
            onSome: (row) => row.since,
          }),
        }))
      ),

    feedStates: sql
      .all("feedStates", feedStatesStatement, FeedStateRow)
      .pipe(Effect.map(Array.map(feedStateOfRow))),

    find: (id) =>
      sql
        .all("findJob", findJobStatement(id), EnrichedJobRow)
        .pipe(
          Effect.flatMap((rows) =>
            Effect.transposeOption(
              Option.map(Array.head(rows), jobDetailOfRow("findJob"))
            )
          )
        ),

    historyOf: (job) =>
      sql
        .all("historyOf", historyStatement(job), HistoryRow)
        .pipe(Effect.map((rows) => Option.map(Array.head(rows), historyOfRow))),
    list: (query, now) =>
      Effect.all(
        {
          rows: sql.all(
            "listJobs",
            listJobsStatement(query, now),
            ListedJobRow
          ),
          total: sql.all("countJobs", countJobsStatement(query, now), TotalRow),
        },
        { concurrency: 2 }
      ).pipe(
        Effect.flatMap(({ rows, total }) =>
          pipe(rows, Array.map(listedJobOfRow(now)), Effect.all).pipe(
            Effect.map((jobs) => ({ jobs, total: totalOf(total) }))
          )
        )
      ),

    neuronsClaimed: (day) =>
      sql.all("neuronsClaimed", neuronsClaimedStatement(day), TotalRow).pipe(
        Effect.map((rows) =>
          Option.match(Array.head(rows), {
            onNone: () => 0,
            onSome: (row) => row.total,
          })
        )
      ),

    pruneOlderThan: (cutoff) =>
      sql
        .batch("pruneOlderThan", [
          pruneJobsStatement(cutoff),
          pruneRunsStatement(cutoff),
          pruneOrphanEnrichmentStatement,
          pruneOrphanSkipStatement,
          pruneNeuronsStatement(cutoff),
        ])
        .pipe(
          Effect.map((results) =>
            Option.match(Array.head(results), {
              onNone: () => 0,
              onSome: (result) => result.changes,
            })
          )
        ),

    recordFeedFailure: (feedKey, attemptedAt, message) =>
      sql
        .batch("recordFeedFailure", [
          feedFailedStatement(feedKey, attemptedAt, message),
        ])
        .pipe(Effect.asVoid),

    recordNeuronsUsed: (usage) =>
      sql
        .batch("recordNeuronsUsed", [recordNeuronsUsedStatement(usage)])
        .pipe(Effect.asVoid),

    recordRun: (receipt) =>
      sql.batch("recordRun", [recordRunStatement(receipt)]).pipe(Effect.asVoid),

    recordSightings: (listings, seenAt) =>
      Effect.forEach(
        Array.chunksOf(listings, UPSERT_CHUNK),
        (chunk) =>
          sql.batch(
            "recordSightings",
            pipe(
              chunk,
              Array.map((listing) => sightingStatement(listing, seenAt))
            )
          ),
        { discard: true }
      ),

    recordSkip: (id, skip) =>
      sql
        .batch("recordSkip", [recordSkipStatement(id, skip)])
        .pipe(Effect.asVoid),

    releaseIngest: (startedAt) =>
      sql
        .batch("releaseIngest", [releaseIngestStatement(startedAt)])
        .pipe(Effect.asVoid),

    replaceFeed: (feedKey, jobs, seenAt) =>
      Effect.gen(function* replaceFeed() {
        const chunks = pipe(
          Array.chunksOf(jobs, UPSERT_CHUNK),
          Array.map(
            Array.flatMap((job) => [
              upsertJobStatement(job),
              sightingStatement(job, seenAt),
            ])
          )
        );

        yield* Effect.forEach(
          chunks,
          (chunk) => sql.batch("upsertJobs", chunk),
          {
            discard: true,
          }
        );

        const [removed] = yield* sql.batch("replaceFeed", [
          removeUnseenStatement(feedKey, seenAt),
          feedSucceededStatement(feedKey, seenAt),
        ]);

        return { removed: removed?.changes ?? 0, upserted: jobs.length };
      }),

    saveEnrichment: (id, enrichment) =>
      sql
        .batch("saveEnrichment", [
          saveEnrichmentStatement(id, enrichment),
          clearSkipStatement(id),
        ])
        .pipe(Effect.asVoid),

    stats: (now) =>
      Effect.all(
        {
          active: sql.all("activeJobs", activeCountStatement(now), TotalRow),
          feeds: sql.all("feedHealth", feedHealthStatement, FeedHealthRow),
          lastRun: sql.all("lastRun", lastRunStatement, RunRow),
          newToday: sql.all("newToday", newTodayStatement(now), TotalRow),
          regions: sql.all(
            "regionCounts",
            regionCountsStatement(now),
            RegionCountRow
          ),
          roles: sql.all("roleCounts", roleCountsStatement(now), RoleCountRow),
        },
        { concurrency: 3 }
      ).pipe(
        Effect.map(({ active, feeds, lastRun, newToday, regions, roles }) => {
          const health = Array.head(feeds);

          return {
            activeJobs: totalOf(active),
            feedsFailing: Option.match(health, {
              onNone: () => 0,
              onSome: (row) => row.failing,
            }),
            feedsTotal: Option.match(health, {
              onNone: () => 0,
              onSome: (row) => row.total,
            }),
            lastRun: pipe(
              Array.head(lastRun),
              Option.map(receiptOfRow),
              Option.getOrNull
            ),
            newToday: totalOf(newToday),
            regions,
            roles,
          };
        })
      ),

    unenrichedListings: (sweep) =>
      sql
        .all("unenrichedListings", unenrichedListingsStatement(sweep), IdRow)
        .pipe(Effect.map(Array.map((row) => row.id))),
  });
});

export const jobStoreLayer = Layer.effect(JobStore, makeJobStore);
