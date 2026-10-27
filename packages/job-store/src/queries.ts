import {
  companySlugOf,
  COMPANY_LISTING_ROWS,
  DAY_MILLIS,
  fingerprintOf,
  MAX_AGE_DAYS,
  paidFeatureSources,
  paidFeaturesAllowed,
  RECENCY_PENALTY_PER_DAY,
  REPOST_GAP,
  SourceName,
  sourceOfFeedKey,
} from "@rat-stack/core";
import type {
  BoardFactsRow,
  EnrichmentSkip,
  EnrichmentValue,
  IngestReceiptValue,
  JobQueryValue,
  JobValue,
  NeuronClaim,
  NeuronUsage,
  Retention,
  Sighted,
  SourceNameValue,
  UnenrichedSweep,
} from "@rat-stack/core";
import { Option } from "effect";

import { statement } from "./sql-executor.js";
import type { SqlStatement, SqlValue } from "./sql-executor.js";

export const UPSERT_CHUNK = 40;

export const FEED_STATE_LIMIT = 5000;

export const placeholders = (count: number) =>
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

export const jobColumns = jobColumnNames.join(", ");

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
  "board",
  "hands_on",
  "prompt_version",
] as const;

export const BOARD_MODEL_PREFIX = "source:";

const enrichmentColumns = enrichmentColumnNames.join(", ");

const enrichedJobs =
  "jobs LEFT JOIN job_enrichment ON job_enrichment.job_id = jobs.id";

const rankedColumns = [...jobColumnNames, ...enrichmentColumnNames]
  .map((column) => `ranked.${column}`)
  .join(", ");

const servedSourcesCondition = (sources: readonly SourceNameValue[]) =>
  SourceName.literals.some((source) => !sources.includes(source))
    ? {
        conditions: [`source IN (${placeholders(sources.length)})`],
        params: [...sources],
      }
    : { conditions: [], params: [] };

const servedJobsSince = (
  column: "first_seen_at" | "posted_at",
  since: number,
  sources: readonly SourceNameValue[]
) => {
  const served = servedSourcesCondition(sources);

  return {
    params: [since, ...served.params],
    where: [`${column} >= ?`, "departed_at IS NULL", ...served.conditions].join(
      " AND "
    ),
  };
};

const filteredJobs = (
  query: JobQueryValue,
  now: number,
  sources: readonly SourceNameValue[],
  companySlug?: string
) => {
  const conditions = ["posted_at >= ?", "departed_at IS NULL"];
  const params: SqlValue[] = [now - query.maxAgeDays * DAY_MILLIS];

  if (companySlug !== undefined) {
    conditions.push("jobs.company_slug = ?");
    params.push(companySlug);
  }

  const served = servedSourcesCondition(sources);

  conditions.push(...served.conditions);
  params.push(...served.params);

  if (query.roles.length > 0) {
    conditions.push(`role IN (${placeholders(query.roles.length)})`);
    params.push(...query.roles);
  }

  if (query.regions.length > 0) {
    conditions.push(`region IN (${placeholders(query.regions.length)})`);
    params.push(...query.regions);
  }

  if (query.salaryListed) {
    const paidSources = paidFeatureSources();

    conditions.push(
      `(salary IS NOT NULL OR salary_currency IS NOT NULL) AND source IN (${placeholders(paidSources.length)})`
    );
    params.push(...paidSources);
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
  SELECT ${jobColumns}, ${enrichmentColumns}, fingerprint, departed_at,
    ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY ${sourcePriority}, posted_at ASC, id ASC) AS duplicate_rank
  FROM ${enrichedJobs}
  WHERE ${conditions.join(" AND ")}
)`,
  };
};

export const listJobsStatement = (
  query: JobQueryValue,
  now: number,
  sources: readonly SourceNameValue[],
  companySlug?: string
): SqlStatement => {
  const filtered = filteredJobs(query, now, sources, companySlug);

  const order =
    query.sort === "Newest"
      ? "posted_at DESC, id ASC"
      : `(relevance - ((? - posted_at) / ${DAY_MILLIS}.0) * ${RECENCY_PENALTY_PER_DAY}) DESC, posted_at DESC, id ASC`;

  return statement(
    `${filtered.sql}
SELECT ${rankedColumns}, ranked.departed_at,
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

const companyQuery: JobQueryValue = {
  limit: COMPANY_LISTING_ROWS,
  maxAgeDays: MAX_AGE_DAYS,
  offset: 0,
  regions: [],
  roles: [],
  salaryFloor: null,
  salaryListed: false,
  search: "",
  seniorities: [],
  sort: "Newest",
};

export const companyJobsStatement = (slug: string, now: number) =>
  listJobsStatement(companyQuery, now, SourceName.literals, slug);

export const companySummaryStatement = (slug: string, now: number) => {
  const filtered = filteredJobs(companyQuery, now, SourceName.literals, slug);

  return statement(
    `${filtered.sql}
SELECT COUNT(*) AS total, MIN(COALESCE(history.first_seen_at, ranked.first_seen_at)) AS opened_at
FROM ranked LEFT JOIN job_history AS history ON history.fingerprint = ranked.fingerprint
WHERE duplicate_rank = 1`,
    filtered.params
  );
};

export const companyOpenRolesStatement = (
  slug: string,
  now: number
): SqlStatement => {
  const sources = paidFeatureSources();

  return statement(
    `WITH ranked AS (
  SELECT jobs.id, jobs.company, jobs.title, jobs.role, jobs.source, jobs.first_seen_at, jobs.fingerprint,
    job_enrichment.salary_currency, job_enrichment.salary_min, job_enrichment.salary_max,
    ROW_NUMBER() OVER (PARTITION BY jobs.fingerprint ORDER BY ${sourcePriority}, posted_at ASC, id ASC) AS duplicate_rank
  FROM ${enrichedJobs}
  WHERE jobs.company_slug = ? AND jobs.departed_at IS NULL AND posted_at >= ? AND source IN (${placeholders(sources.length)})
)
SELECT ranked.id, ranked.company, ranked.title, ranked.role, ranked.source,
  ranked.salary_currency, ranked.salary_min, ranked.salary_max,
  COALESCE(history.stint_started_at, ranked.first_seen_at) AS opened_at,
  COALESCE(history.reposts, 0) AS reposts
FROM ranked LEFT JOIN intel_history AS history ON history.company_slug = ? AND history.fingerprint = ranked.fingerprint
WHERE duplicate_rank = 1`,
    [slug, now - MAX_AGE_DAYS * DAY_MILLIS, ...sources, slug]
  );
};

export const companyHistoryStatement = (
  slug: string,
  since: number
): SqlStatement =>
  statement(
    "SELECT company, last_seen_feed, stint_started_at, last_seen_at, previous_started_at, previous_ended_at FROM intel_history WHERE company_slug = ? AND last_seen_at > ?",
    [slug, since]
  );

export const trackedSinceStatement = statement(
  "SELECT MIN(first_seen_at) AS since FROM intel_history",
  []
);

export const findJobStatement = (
  id: string,
  includeDeparted: boolean
): SqlStatement =>
  statement(
    `SELECT ${jobColumns}, ${enrichmentColumns} FROM ${enrichedJobs} WHERE id = ?${includeDeparted ? "" : " AND departed_at IS NULL"} LIMIT 1`,
    [id]
  );

const aiEnriched = (id: string) =>
  `EXISTS (SELECT 1 FROM job_enrichment WHERE job_enrichment.job_id = ${id} AND job_enrichment.model NOT LIKE '${BOARD_MODEL_PREFIX}%')`;

export const unenrichedListingsStatement = (
  sweep: UnenrichedSweep
): SqlStatement =>
  statement(
    `SELECT jobs.id FROM jobs
LEFT JOIN job_enrichment_skip AS skip ON skip.job_id = jobs.id
WHERE jobs.first_seen_at >= ? AND jobs.departed_at IS NULL AND jobs.source IN (${placeholders(sweep.sources.length)})
  AND NOT EXISTS (SELECT 1 FROM job_enrichment WHERE job_enrichment.job_id = jobs.id AND job_enrichment.model NOT LIKE '${BOARD_MODEL_PREFIX}%' AND COALESCE(job_enrichment.prompt_version, 1) >= ?)
  AND (skip.reason IS NULL OR skip.reason NOT IN (${placeholders(sweep.finalSkips.length)}))
ORDER BY skip.reason IS NOT NULL, ${aiEnriched("jobs.id")}, jobs.first_seen_at DESC, jobs.id
LIMIT ?`,
    [
      sweep.since,
      ...sweep.sources,
      sweep.promptVersion,
      ...sweep.finalSkips,
      sweep.limit,
    ]
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

const keepBoardFact = (column: string, presence: string) =>
  `${column} = CASE WHEN excluded.${presence} IS NULL OR (job_enrichment.board IS NOT NULL AND job_enrichment.${presence} IS NOT NULL) THEN job_enrichment.${column} ELSE excluded.${column} END`;

export const saveEnrichmentStatement = (
  id: string,
  enrichment: EnrichmentValue
): SqlStatement =>
  statement(
    `INSERT INTO job_enrichment (job_id, ${enrichmentColumns})
VALUES (${placeholders(enrichmentColumnNames.length + 1)})
ON CONFLICT (job_id) DO UPDATE SET
  ${keepBoardFact("salary_currency", "salary_currency")},
  ${keepBoardFact("salary_min", "salary_currency")},
  ${keepBoardFact("salary_max", "salary_currency")},
  ${keepBoardFact("seniority", "seniority")},
  team_size = COALESCE(excluded.team_size, job_enrichment.team_size),
  reports_to = COALESCE(excluded.reports_to, job_enrichment.reports_to),
  ${keepBoardFact("remote_policy", "remote_policy")},
  model = excluded.model,
  enriched_at = excluded.enriched_at,
  board = COALESCE(job_enrichment.board, excluded.board),
  hands_on = COALESCE(excluded.hands_on, job_enrichment.hands_on),
  prompt_version = excluded.prompt_version`,
    [
      id,
      enrichment.salary?.currency ?? null,
      enrichment.salary?.min ?? null,
      enrichment.salary?.max ?? null,
      enrichment.seniority,
      enrichment.teamSize,
      enrichment.reportsTo,
      enrichment.remotePolicy,
      enrichment.model ?? `${BOARD_MODEL_PREFIX}${enrichment.board}`,
      enrichment.enrichedAt,
      enrichment.board,
      enrichment.handsOn,
      enrichment.promptVersion,
    ]
  );

const takeBoardFact = (column: string, presence: string) =>
  `${column} = CASE WHEN excluded.${presence} IS NULL THEN job_enrichment.${column} ELSE excluded.${column} END`;

const boardFactChanges = (columns: readonly string[], presence: string) =>
  `(excluded.${presence} IS NOT NULL AND (${columns
    .map((column) => `job_enrichment.${column} IS NOT excluded.${column}`)
    .join(" OR ")}))`;

export const saveBoardFactsStatement = (
  { board, facts, id }: BoardFactsRow,
  seenAt: number
): SqlStatement =>
  statement(
    `INSERT INTO job_enrichment (job_id, ${enrichmentColumns})
VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL)
ON CONFLICT (job_id) DO UPDATE SET
  ${takeBoardFact("salary_currency", "salary_currency")},
  ${takeBoardFact("salary_min", "salary_currency")},
  ${takeBoardFact("salary_max", "salary_currency")},
  ${takeBoardFact("seniority", "seniority")},
  ${takeBoardFact("remote_policy", "remote_policy")},
  board = excluded.board
WHERE job_enrichment.board IS NOT excluded.board
  OR ${boardFactChanges(["salary_currency", "salary_min", "salary_max"], "salary_currency")}
  OR ${boardFactChanges(["seniority"], "seniority")}
  OR ${boardFactChanges(["remote_policy"], "remote_policy")}`,
    [
      id,
      facts.salary?.currency ?? null,
      facts.salary?.min ?? null,
      facts.salary?.max ?? null,
      facts.seniority,
      facts.remotePolicy,
      `${BOARD_MODEL_PREFIX}${board}`,
      seenAt,
      board,
    ]
  );

export const countJobsStatement = (
  query: JobQueryValue,
  now: number,
  sources: readonly SourceNameValue[]
): SqlStatement => {
  const filtered = filteredJobs(query, now, sources);

  return statement(
    `${filtered.sql}
SELECT COUNT(*) AS total FROM ranked WHERE duplicate_rank = 1`,
    filtered.params
  );
};

export const upsertJobStatement = (job: JobValue): SqlStatement =>
  statement(
    `INSERT INTO jobs (${jobColumns}, fingerprint, company_slug)
VALUES (${placeholders(17)})
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
  departed_at = NULL,
  fingerprint = excluded.fingerprint,
  company_slug = excluded.company_slug`,
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
      Option.getOrElse(companySlugOf(job.company), () => ""),
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

const reopenIntelStatement = (job: Sighted, seenAt: number): SqlStatement =>
  statement(
    `UPDATE intel_history SET
  reposts = reposts + 1,
  previous_started_at = stint_started_at,
  previous_ended_at = last_seen_at,
  stint_started_at = ?
WHERE company_slug = ? AND fingerprint = ?
  AND last_seen_at < ? - ?
  AND last_seen_at < COALESCE((
    SELECT CASE
      WHEN last_success_at < ? THEN last_success_at
      WHEN previous_success_at < ? THEN previous_success_at
    END
    FROM feeds WHERE key = intel_history.last_seen_feed
  ), 0)`,
    [
      seenAt,
      Option.getOrElse(companySlugOf(job.company), () => ""),
      fingerprintOf(job),
      seenAt,
      REPOST_GAP,
      seenAt,
      seenAt,
    ]
  );

const seenIntelStatement = (job: Sighted, seenAt: number): SqlStatement =>
  statement(
    `INSERT INTO intel_history (company_slug, fingerprint, company, first_seen_at, stint_started_at, last_seen_at, last_seen_feed, reposts)
VALUES (?, ?, ?, ?, ?, ?, ?, 0)
ON CONFLICT (company_slug, fingerprint) DO UPDATE SET
  company = CASE
    WHEN intel_history.last_seen_at < excluded.last_seen_at THEN excluded.company
    ELSE intel_history.company
  END,
  last_seen_at = MAX(intel_history.last_seen_at, excluded.last_seen_at),
  last_seen_feed = CASE
    WHEN intel_history.last_seen_at < excluded.last_seen_at THEN excluded.last_seen_feed
    WHEN intel_history.last_seen_at = excluded.last_seen_at THEN MIN(intel_history.last_seen_feed, excluded.last_seen_feed)
    ELSE intel_history.last_seen_feed
  END`,
    [
      Option.getOrElse(companySlugOf(job.company), () => ""),
      fingerprintOf(job),
      job.company,
      seenAt,
      seenAt,
      seenAt,
      job.feed,
    ]
  );

export const intelSightingStatements = (
  job: Sighted,
  seenAt: number
): readonly SqlStatement[] =>
  Option.exists(sourceOfFeedKey(job.feed), (source) =>
    paidFeaturesAllowed(source)
  )
    ? [reopenIntelStatement(job, seenAt), seenIntelStatement(job, seenAt)]
    : [];

export const historyStatement = (job: Pick<JobValue, "company" | "title">) =>
  statement(
    "SELECT first_seen_at, last_seen_at, sightings, reposts FROM job_history WHERE fingerprint = ?",
    [fingerprintOf(job)]
  );

export const departUnseenStatement = (
  feedKey: string,
  seenAt: number
): SqlStatement =>
  statement(
    "UPDATE jobs SET departed_at = ? WHERE feed = ? AND last_seen_at < ? AND departed_at IS NULL",
    [seenAt, feedKey, seenAt]
  );

export const markListedStatement = (
  feedKey: string,
  ids: readonly string[],
  seenAt: number
): SqlStatement =>
  statement(
    "UPDATE jobs SET last_seen_at = MAX(last_seen_at, ?), departed_at = NULL WHERE feed = ? AND id IN (SELECT value FROM json_each(?))",
    [seenAt, feedKey, JSON.stringify(ids)]
  );

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
    "UPDATE enrichment_neurons SET used = used + ?, claimed = MAX(0, claimed + ? - ?) WHERE day = ? AND ? >= 0",
    [usage.neurons, usage.neurons, usage.claimed, usage.day, usage.neurons]
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

export const pruneJobsStatement = ({
  departedBefore,
  unseenBefore,
}: Retention) =>
  statement("DELETE FROM jobs WHERE departed_at < ? OR last_seen_at < ?", [
    departedBefore,
    unseenBefore,
  ]);

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

export const activeCountStatement = (
  now: number,
  sources: readonly SourceNameValue[]
) => {
  const active = servedJobsSince(
    "posted_at",
    now - MAX_AGE_DAYS * DAY_MILLIS,
    sources
  );

  return statement(
    `SELECT COUNT(*) AS total FROM jobs WHERE ${active.where}`,
    active.params
  );
};

export const newTodayStatement = (
  now: number,
  sources: readonly SourceNameValue[]
) => {
  const fresh = servedJobsSince("first_seen_at", now - DAY_MILLIS, sources);

  return statement(
    `SELECT COUNT(*) AS total FROM jobs WHERE ${fresh.where}`,
    fresh.params
  );
};

export const regionCountsStatement = (
  now: number,
  sources: readonly SourceNameValue[]
) => {
  const active = servedJobsSince(
    "posted_at",
    now - MAX_AGE_DAYS * DAY_MILLIS,
    sources
  );

  return statement(
    `SELECT region, COUNT(*) AS count FROM jobs WHERE ${active.where} GROUP BY region ORDER BY count DESC`,
    active.params
  );
};

export const roleCountsStatement = (
  now: number,
  sources: readonly SourceNameValue[]
) => {
  const active = servedJobsSince(
    "posted_at",
    now - MAX_AGE_DAYS * DAY_MILLIS,
    sources
  );

  return statement(
    `SELECT role, COUNT(*) AS count FROM jobs WHERE ${active.where} GROUP BY role ORDER BY count DESC`,
    active.params
  );
};

export const placementCountsStatement = (
  now: number,
  sources: readonly SourceNameValue[]
) => {
  const active = servedJobsSince(
    "posted_at",
    now - MAX_AGE_DAYS * DAY_MILLIS,
    sources
  );

  return statement(
    `SELECT role, region, COUNT(*) AS count FROM jobs WHERE ${active.where} GROUP BY role, region ORDER BY count DESC`,
    active.params
  );
};

export const TOP_COMPANIES = 12;

export const companyCountsStatement = (
  now: number,
  sources: readonly SourceNameValue[]
) => {
  const active = servedJobsSince(
    "posted_at",
    now - MAX_AGE_DAYS * DAY_MILLIS,
    sources
  );

  return statement(
    `SELECT company_slug AS slug, MIN(company) AS company, COUNT(*) AS count FROM jobs WHERE ${active.where} AND company_slug <> '' GROUP BY company_slug ORDER BY count DESC, slug LIMIT ${TOP_COMPANIES}`,
    active.params
  );
};

export const feedHealthStatement = (catalogKeys: readonly string[]) =>
  statement(
    "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN consecutive_failures > 0 THEN 1 ELSE 0 END), 0) AS failing FROM feeds WHERE key IN (SELECT value FROM json_each(?))",
    [JSON.stringify(catalogKeys)]
  );

export const lastRunStatement = statement(
  `SELECT started_at, finished_at, feeds_attempted, feeds_failed, jobs_upserted, jobs_pruned, outcome
FROM ingest_runs ORDER BY started_at DESC LIMIT 1`
);
