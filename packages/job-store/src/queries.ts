import {
  DAY_MILLIS,
  fingerprintOf,
  MAX_AGE_DAYS,
  RECENCY_PENALTY_PER_DAY,
  REPOST_GAP,
  unspentNeurons,
} from "@rat-stack/core";
import type {
  EnrichmentSkip,
  EnrichmentValue,
  IngestReceiptValue,
  JobQueryValue,
  JobValue,
  NeuronClaim,
  NeuronUsage,
  Sighted,
  UnenrichedSweep,
} from "@rat-stack/core";

import { statement } from "./sql-executor.js";
import type { SqlStatement, SqlValue } from "./sql-executor.js";

export const UPSERT_CHUNK = 40;

export const FEED_STATE_LIMIT = 5000;

const placeholders = (count: number) =>
  Array.from({ length: count }, () => "?").join(", ");

const likePattern = (search: string) =>
  `%${search.replaceAll(/[\\%_]/gu, (match) => `\\${match}`)}%`;

const sourcePriority = `CASE source
  WHEN 'Greenhouse' THEN 0 WHEN 'Lever' THEN 0 WHEN 'Ashby' THEN 0
  WHEN 'Workable' THEN 0 WHEN 'SmartRecruiters' THEN 0
  WHEN 'HackerNews' THEN 1 ELSE 2 END`;

const jobColumnNames = [
  "id",
  "feed",
  "source",
  "title",
  "company",
  "location",
  "region",
  "arrangement",
  "role",
  "url",
  "salary",
  "relevance",
  "posted_at",
  "first_seen_at",
  "last_seen_at",
] as const;

const jobColumns = jobColumnNames.join(", ");

const enrichmentColumnNames = [
  "salary_currency",
  "salary_min",
  "salary_max",
  "seniority",
  "team_size",
  "reports_to",
  "remote_policy",
  "model",
  "enriched_at",
] as const;

const enrichmentColumns = enrichmentColumnNames.join(", ");

const enrichedJobs =
  "jobs LEFT JOIN job_enrichment ON job_enrichment.job_id = jobs.id";

const rankedColumns = [...jobColumnNames, ...enrichmentColumnNames]
  .map((column) => `ranked.${column}`)
  .join(", ");

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

  if (query.salaryFloor !== null) {
    conditions.push("salary_currency = ? AND salary_max >= ?");
    params.push(query.salaryFloor.currency, query.salaryFloor.amount);
  }

  if (query.seniorities.length > 0) {
    conditions.push(`seniority IN (${placeholders(query.seniorities.length)})`);
    params.push(...query.seniorities);
  }

  return {
    params,
    sql: `WITH ranked AS (
  SELECT ${jobColumns}, ${enrichmentColumns}, fingerprint,
    ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY ${sourcePriority}, posted_at ASC, id ASC) AS duplicate_rank
  FROM ${enrichedJobs}
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
SELECT ${rankedColumns},
  COALESCE(history.first_seen_at, ranked.first_seen_at) AS opened_at,
  COALESCE(history.reposts, 0) AS reposts
FROM ranked LEFT JOIN job_history AS history ON history.fingerprint = ranked.fingerprint
WHERE duplicate_rank = 1
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
  statement(
    `SELECT ${jobColumns}, ${enrichmentColumns} FROM ${enrichedJobs} WHERE id = ? LIMIT 1`,
    [id]
  );

export const unenrichedListingsStatement = (
  sweep: UnenrichedSweep
): SqlStatement =>
  statement(
    `SELECT jobs.id FROM jobs
LEFT JOIN job_enrichment_skip AS skip ON skip.job_id = jobs.id
WHERE jobs.first_seen_at >= ? AND jobs.source IN (${placeholders(sweep.sources.length)})
  AND NOT EXISTS (SELECT 1 FROM job_enrichment WHERE job_enrichment.job_id = jobs.id)
  AND (skip.reason IS NULL OR skip.reason NOT IN (${placeholders(sweep.finalSkips.length)}))
ORDER BY skip.reason IS NOT NULL, jobs.first_seen_at DESC, jobs.id
LIMIT ?`,
    [sweep.since, ...sweep.sources, ...sweep.finalSkips, sweep.limit]
  );

export const recordSkipStatement = (
  id: string,
  skip: EnrichmentSkip
): SqlStatement =>
  statement(
    `INSERT INTO job_enrichment_skip (job_id, reason, skipped_at)
VALUES (?, ?, ?)
ON CONFLICT (job_id) DO UPDATE SET
  reason = excluded.reason,
  skipped_at = excluded.skipped_at`,
    [id, skip.reason, skip.skippedAt]
  );

export const clearSkipStatement = (id: string) =>
  statement("DELETE FROM job_enrichment_skip WHERE job_id = ?", [id]);

export const saveEnrichmentStatement = (
  id: string,
  enrichment: EnrichmentValue
): SqlStatement =>
  statement(
    `INSERT INTO job_enrichment (job_id, ${enrichmentColumns})
VALUES (${placeholders(enrichmentColumnNames.length + 1)})
ON CONFLICT (job_id) DO UPDATE SET
  salary_currency = excluded.salary_currency,
  salary_min = excluded.salary_min,
  salary_max = excluded.salary_max,
  seniority = excluded.seniority,
  team_size = excluded.team_size,
  reports_to = excluded.reports_to,
  remote_policy = excluded.remote_policy,
  model = excluded.model,
  enriched_at = excluded.enriched_at`,
    [
      id,
      enrichment.salary?.currency ?? null,
      enrichment.salary?.min ?? null,
      enrichment.salary?.max ?? null,
      enrichment.seniority,
      enrichment.teamSize,
      enrichment.reportsTo,
      enrichment.remotePolicy,
      enrichment.model,
      enrichment.enrichedAt,
    ]
  );

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
  last_seen_at = MAX(jobs.last_seen_at, excluded.last_seen_at),
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

export const sightingStatement = (job: Sighted, seenAt: number): SqlStatement =>
  statement(
    `INSERT INTO job_history (fingerprint, first_seen_at, last_seen_at, last_seen_feed, sightings, reposts)
VALUES (?, MIN(COALESCE((SELECT MIN(first_seen_at) FROM jobs WHERE fingerprint = ?), ?), ?), ?, ?, 1, 0)
ON CONFLICT (fingerprint) DO UPDATE SET
  first_seen_at = MIN(job_history.first_seen_at, excluded.first_seen_at),
  last_seen_at = MAX(job_history.last_seen_at, excluded.last_seen_at),
  last_seen_feed = CASE
    WHEN job_history.last_seen_at < excluded.last_seen_at THEN excluded.last_seen_feed
    WHEN job_history.last_seen_at = excluded.last_seen_at THEN MIN(job_history.last_seen_feed, excluded.last_seen_feed)
    ELSE job_history.last_seen_feed
  END,
  sightings = job_history.sightings + (job_history.last_seen_at < excluded.last_seen_at),
  reposts = job_history.reposts + (
    job_history.last_seen_at < excluded.last_seen_at - ?
    AND job_history.last_seen_at < COALESCE((
      SELECT CASE
        WHEN last_success_at < ? THEN last_success_at
        WHEN previous_success_at < ? THEN previous_success_at
      END
      FROM feeds WHERE key = job_history.last_seen_feed
    ), 0)
  )`,
    [
      fingerprintOf(job),
      fingerprintOf(job),
      seenAt,
      seenAt,
      seenAt,
      job.feed,
      REPOST_GAP,
      seenAt,
      seenAt,
    ]
  );

export const historyStatement = (job: Pick<JobValue, "company" | "title">) =>
  statement(
    "SELECT first_seen_at, last_seen_at, sightings, reposts FROM job_history WHERE fingerprint = ?",
    [fingerprintOf(job)]
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
  last_attempt_at = MAX(COALESCE(feeds.last_attempt_at, 0), excluded.last_attempt_at),
  last_success_at = MAX(COALESCE(feeds.last_success_at, 0), excluded.last_success_at),
  previous_success_at = CASE
    WHEN excluded.last_success_at > feeds.last_success_at THEN MAX(COALESCE(feeds.previous_success_at, 0), feeds.last_success_at)
    WHEN excluded.last_success_at < feeds.last_success_at THEN MAX(COALESCE(feeds.previous_success_at, 0), excluded.last_success_at)
    ELSE feeds.previous_success_at
  END,
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
  last_attempt_at = MAX(COALESCE(feeds.last_attempt_at, 0), excluded.last_attempt_at),
  last_error = excluded.last_error,
  consecutive_failures = feeds.consecutive_failures + 1`,
    [feedKey, attemptedAt, message]
  );

export const feedStatesStatement = statement(
  `SELECT key, last_attempt_at, last_success_at, last_error, consecutive_failures
FROM feeds ORDER BY key LIMIT ${FEED_STATE_LIMIT}`
);

export const claimIngestStatement = (startedAt: number, heldUntil: number) =>
  statement(
    "UPDATE ingest_lease SET started_at = ?, held_until = ? WHERE id = 1 AND held_until <= ?",
    [startedAt, heldUntil, startedAt]
  );

export const claimNeuronsStatement = ({ budget, day, neurons }: NeuronClaim) =>
  statement(
    `INSERT INTO enrichment_neurons (day, claimed) SELECT ?, ? WHERE ? <= ?
ON CONFLICT (day) DO UPDATE SET claimed = claimed + excluded.claimed WHERE claimed + excluded.claimed <= ?`,
    [day, neurons, neurons, budget, budget]
  );

export const neuronsClaimedStatement = (day: number) =>
  statement(
    "SELECT COALESCE(SUM(claimed), 0) AS total FROM enrichment_neurons WHERE day = ?",
    [day]
  );

export const recordNeuronsUsedStatement = (usage: NeuronUsage) =>
  statement(
    "UPDATE enrichment_neurons SET used = used + ?, claimed = MAX(0, claimed - ?) WHERE day = ?",
    [usage.neurons, unspentNeurons(usage), usage.day]
  );

export const pruneNeuronsStatement = (cutoff: number) =>
  statement("DELETE FROM enrichment_neurons WHERE day < ?", [
    Math.floor(cutoff / DAY_MILLIS),
  ]);

export const releaseIngestStatement = (startedAt: number) =>
  statement(
    "UPDATE ingest_lease SET held_until = started_at WHERE id = 1 AND started_at = ?",
    [startedAt]
  );

export const pruneJobsStatement = (cutoff: number) =>
  statement("DELETE FROM jobs WHERE posted_at < ?", [cutoff]);

export const pruneOrphanEnrichmentStatement = statement(
  "DELETE FROM job_enrichment WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_enrichment.job_id)"
);

export const pruneOrphanSkipStatement = statement(
  "DELETE FROM job_enrichment_skip WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_enrichment_skip.job_id)"
);

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
