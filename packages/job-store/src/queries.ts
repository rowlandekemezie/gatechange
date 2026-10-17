import {
  DAY_MILLIS,
  MAX_AGE_DAYS,
  RECENCY_PENALTY_PER_DAY,
} from "@rat-stack/core";
import type {
  IngestReceiptValue,
  JobQueryValue,
  JobValue,
} from "@rat-stack/core";

import { statement } from "./sql-executor.js";
import type { SqlStatement, SqlValue } from "./sql-executor.js";

export const UPSERT_CHUNK = 40;

export const FEED_STATE_LIMIT = 5000;

export const fingerprintOf = (job: Pick<JobValue, "company" | "title">) =>
  `${job.company}|${job.title}`.toLowerCase().replaceAll(/[^a-z0-9|]+/gu, "");

const placeholders = (count: number) =>
  Array.from({ length: count }, () => "?").join(", ");

const likePattern = (search: string) =>
  `%${search.replaceAll(/[\\%_]/gu, (match) => `\\${match}`)}%`;

const sourcePriority = `CASE source
  WHEN 'Greenhouse' THEN 0 WHEN 'Lever' THEN 0 WHEN 'Ashby' THEN 0
  WHEN 'Workable' THEN 0 WHEN 'SmartRecruiters' THEN 0
  WHEN 'HackerNews' THEN 1 ELSE 2 END`;

const jobColumns =
  "id, feed, source, title, company, location, region, arrangement, role, url, salary, relevance, posted_at, first_seen_at, last_seen_at";

const filteredJobs = (query: JobQueryValue, now: number) => {
  const conditions = ["posted_at >= ?"];
  const params: SqlValue[] = [now - query.maxAgeDays * DAY_MILLIS];

  if (query.roles.length > 0) {
    conditions.push(`role IN (${placeholders(query.roles.length)})`);
    params.push(...query.roles);
  }

  if (query.regions.length > 0) {
    conditions.push(`region IN (${placeholders(query.regions.length)})`);
    params.push(...query.regions);
  }

  const search = query.search.trim();

  if (search.length > 0) {
    const pattern = likePattern(search);

    conditions.push(
      "(title LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\')"
    );
    params.push(pattern, pattern, pattern);
  }

  return {
    params,
    sql: `WITH ranked AS (
  SELECT ${jobColumns},
    ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY ${sourcePriority}, posted_at ASC, id ASC) AS duplicate_rank
  FROM jobs
  WHERE ${conditions.join(" AND ")}
)`,
  };
};

export const listJobsStatement = (
  query: JobQueryValue,
  now: number
): SqlStatement => {
  const filtered = filteredJobs(query, now);

  const order =
    query.sort === "Newest"
      ? "posted_at DESC, id ASC"
      : `(relevance - ((? - posted_at) / ${DAY_MILLIS}.0) * ${RECENCY_PENALTY_PER_DAY}) DESC, posted_at DESC, id ASC`;

  return statement(
    `${filtered.sql}
SELECT ${jobColumns} FROM ranked WHERE duplicate_rank = 1
ORDER BY ${order}
LIMIT ? OFFSET ?`,
    [
      ...filtered.params,
      ...(query.sort === "Newest" ? [] : [now]),
      query.limit,
      query.offset,
    ]
  );
};

export const findJobStatement = (id: string): SqlStatement =>
  statement(`SELECT ${jobColumns} FROM jobs WHERE id = ? LIMIT 1`, [id]);

export const countJobsStatement = (
  query: JobQueryValue,
  now: number
): SqlStatement => {
  const filtered = filteredJobs(query, now);

  return statement(
    `${filtered.sql}
SELECT COUNT(*) AS total FROM ranked WHERE duplicate_rank = 1`,
    filtered.params
  );
};

export const upsertJobStatement = (job: JobValue): SqlStatement =>
  statement(
    `INSERT INTO jobs (${jobColumns}, fingerprint)
VALUES (${placeholders(16)})
ON CONFLICT (id) DO UPDATE SET
  title = excluded.title,
  company = excluded.company,
  location = excluded.location,
  region = excluded.region,
  arrangement = excluded.arrangement,
  role = excluded.role,
  url = excluded.url,
  salary = excluded.salary,
  relevance = excluded.relevance,
  posted_at = MIN(jobs.posted_at, excluded.posted_at),
  last_seen_at = excluded.last_seen_at,
  fingerprint = excluded.fingerprint`,
    [
      job.id,
      job.feed,
      job.source,
      job.title,
      job.company,
      job.location,
      job.region,
      job.arrangement,
      job.role,
      job.url,
      job.salary,
      job.relevance,
      job.postedAt,
      job.firstSeenAt,
      job.lastSeenAt,
      fingerprintOf(job),
    ]
  );

export const removeUnseenStatement = (
  feedKey: string,
  seenAt: number
): SqlStatement =>
  statement("DELETE FROM jobs WHERE feed = ? AND last_seen_at < ?", [
    feedKey,
    seenAt,
  ]);

export const feedSucceededStatement = (
  feedKey: string,
  seenAt: number
): SqlStatement =>
  statement(
    `INSERT INTO feeds (key, last_attempt_at, last_success_at, last_error, consecutive_failures)
VALUES (?, ?, ?, NULL, 0)
ON CONFLICT (key) DO UPDATE SET
  last_attempt_at = excluded.last_attempt_at,
  last_success_at = excluded.last_success_at,
  last_error = NULL,
  consecutive_failures = 0`,
    [feedKey, seenAt, seenAt]
  );

export const feedFailedStatement = (
  feedKey: string,
  attemptedAt: number,
  message: string
) =>
  statement(
    `INSERT INTO feeds (key, last_attempt_at, last_success_at, last_error, consecutive_failures)
VALUES (?, ?, NULL, ?, 1)
ON CONFLICT (key) DO UPDATE SET
  last_attempt_at = excluded.last_attempt_at,
  last_error = excluded.last_error,
  consecutive_failures = feeds.consecutive_failures + 1`,
    [feedKey, attemptedAt, message]
  );

export const feedStatesStatement = statement(
  `SELECT key, last_attempt_at, last_success_at, last_error, consecutive_failures
FROM feeds ORDER BY key LIMIT ${FEED_STATE_LIMIT}`
);

export const pruneJobsStatement = (cutoff: number) =>
  statement("DELETE FROM jobs WHERE posted_at < ?", [cutoff]);

export const pruneRunsStatement = (cutoff: number) =>
  statement("DELETE FROM ingest_runs WHERE started_at < ?", [cutoff]);

export const recordRunStatement = (receipt: IngestReceiptValue) =>
  statement(
    `INSERT OR REPLACE INTO ingest_runs
  (started_at, finished_at, feeds_attempted, feeds_failed, jobs_upserted, jobs_pruned, outcome)
VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      receipt.startedAt,
      receipt.finishedAt,
      receipt.feedsAttempted,
      receipt.feedsFailed,
      receipt.jobsUpserted,
      receipt.jobsPruned,
      receipt.outcome,
    ]
  );

export const activeCountStatement = (now: number) =>
  statement("SELECT COUNT(*) AS total FROM jobs WHERE posted_at >= ?", [
    now - MAX_AGE_DAYS * DAY_MILLIS,
  ]);

export const newTodayStatement = (now: number) =>
  statement("SELECT COUNT(*) AS total FROM jobs WHERE first_seen_at >= ?", [
    now - DAY_MILLIS,
  ]);

export const regionCountsStatement = (now: number) =>
  statement(
    "SELECT region, COUNT(*) AS count FROM jobs WHERE posted_at >= ? GROUP BY region ORDER BY count DESC",
    [now - MAX_AGE_DAYS * DAY_MILLIS]
  );

export const roleCountsStatement = (now: number) =>
  statement(
    "SELECT role, COUNT(*) AS count FROM jobs WHERE posted_at >= ? GROUP BY role ORDER BY count DESC",
    [now - MAX_AGE_DAYS * DAY_MILLIS]
  );

export const feedHealthStatement = statement(
  "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN consecutive_failures > 0 THEN 1 ELSE 0 END), 0) AS failing FROM feeds"
);

export const lastRunStatement = statement(
  `SELECT started_at, finished_at, feeds_attempted, feeds_failed, jobs_upserted, jobs_pruned, outcome
FROM ingest_runs ORDER BY started_at DESC LIMIT 1`
);
