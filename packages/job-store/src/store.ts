import { Array, Effect, Layer, Option, pipe, Schema } from "effect";
import {
  Arrangement,
  IngestOutcome,
  JobStore,
  Region,
  RoleLevel,
  SourceName,
} from "@rat-stack/core";
import type { FeedState, IngestReceipt, JobValue } from "@rat-stack/core";

import {
  activeCountStatement,
  countJobsStatement,
  feedFailedStatement,
  feedHealthStatement,
  feedStatesStatement,
  feedSucceededStatement,
  lastRunStatement,
  listJobsStatement,
  newTodayStatement,
  pruneJobsStatement,
  pruneRunsStatement,
  recordRunStatement,
  regionCountsStatement,
  removeUnseenStatement,
  roleCountsStatement,
  UPSERT_CHUNK,
  upsertJobStatement,
} from "./queries.js";
import { SqlExecutor } from "./sql-executor.js";

const Count = Schema.Finite;

const JobRow = Schema.Struct({
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

const TotalRow = Schema.Struct({ total: Count });

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

const jobOfRow = (row: typeof JobRow.Type): JobValue => ({
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

const feedStateOfRow = (row: typeof FeedStateRow.Type): FeedState => ({
  consecutiveFailures: row.consecutive_failures,
  key: row.key,
  lastAttemptAt: row.last_attempt_at,
  lastError: row.last_error,
  lastSuccessAt: row.last_success_at,
});

const receiptOfRow = (row: typeof RunRow.Type): IngestReceipt => ({
  feedsAttempted: row.feeds_attempted,
  feedsFailed: row.feeds_failed,
  finishedAt: row.finished_at,
  jobsPruned: row.jobs_pruned,
  jobsUpserted: row.jobs_upserted,
  outcome: row.outcome,
  startedAt: row.started_at,
});

const totalOf = (rows: ReadonlyArray<typeof TotalRow.Type>) =>
  Option.match(Array.head(rows), { onNone: () => 0, onSome: (row) => row.total });

export const makeJobStore = Effect.gen(function* makeJobStore() {
  const sql = yield* SqlExecutor;

  return JobStore.of({
    feedStates: sql
      .all("feedStates", feedStatesStatement, FeedStateRow)
      .pipe(Effect.map(Array.map(feedStateOfRow))),

    list: (query, now) =>
      Effect.all(
        {
          rows: sql.all("listJobs", listJobsStatement(query, now), JobRow),
          total: sql.all("countJobs", countJobsStatement(query, now), TotalRow),
        },
        { concurrency: 2 }
      ).pipe(
        Effect.map(({ rows, total }) => ({
          jobs: Array.map(rows, jobOfRow),
          total: totalOf(total),
        }))
      ),

    pruneOlderThan: (cutoff) =>
      sql
        .batch("pruneOlderThan", [pruneJobsStatement(cutoff), pruneRunsStatement(cutoff)])
        .pipe(
          Effect.map((results) =>
            Option.match(Array.head(results), { onNone: () => 0, onSome: (result) => result.changes })
          )
        ),

    recordFeedFailure: (feedKey, attemptedAt, message) =>
      sql
        .batch("recordFeedFailure", [feedFailedStatement(feedKey, attemptedAt, message)])
        .pipe(Effect.asVoid),

    recordRun: (receipt) =>
      sql.batch("recordRun", [recordRunStatement(receipt)]).pipe(Effect.asVoid),

    replaceFeed: (feedKey, jobs, seenAt) =>
      Effect.gen(function* replaceFeed() {
        const chunks = Array.chunksOf(Array.map(jobs, upsertJobStatement), UPSERT_CHUNK);

        yield* Effect.forEach(chunks, (chunk) => sql.batch("upsertJobs", chunk), {
          discard: true,
        });

        const [removed] = yield* sql.batch("replaceFeed", [
          removeUnseenStatement(feedKey, seenAt),
          feedSucceededStatement(feedKey, seenAt),
        ]);

        return { removed: removed?.changes ?? 0, upserted: jobs.length };
      }),

    stats: (now) =>
      Effect.all(
        {
          active: sql.all("activeJobs", activeCountStatement(now), TotalRow),
          feeds: sql.all("feedHealth", feedHealthStatement, FeedHealthRow),
          lastRun: sql.all("lastRun", lastRunStatement, RunRow),
          newToday: sql.all("newToday", newTodayStatement(now), TotalRow),
          regions: sql.all("regionCounts", regionCountsStatement(now), RegionCountRow),
          roles: sql.all("roleCounts", roleCountsStatement(now), RoleCountRow),
        },
        { concurrency: 3 }
      ).pipe(
        Effect.map(({ active, feeds, lastRun, newToday, regions, roles }) => {
          const health = Array.head(feeds);

          return {
            activeJobs: totalOf(active),
            feedsFailing: Option.match(health, { onNone: () => 0, onSome: (row) => row.failing }),
            feedsTotal: Option.match(health, { onNone: () => 0, onSome: (row) => row.total }),
            lastRun: pipe(Array.head(lastRun), Option.map(receiptOfRow), Option.getOrNull),
            newToday: totalOf(newToday),
            regions,
            roles,
          };
        })
      ),
  });
});

export const jobStoreLayer = Layer.effect(JobStore, makeJobStore);
