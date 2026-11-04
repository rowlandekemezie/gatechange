import {
  Arrangement,
  Currency,
  daysOpen,
  Enrichment,
  EVERY_POSTING,
  IngestOutcome,
  JobStore,
  JobStoreUnavailable,
  listingStatus,
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
  HistoryRecord,
  ListingHistory,
  OpenRoleRecord,
} from "@rat-stack/core";
import { Array, Effect, Layer, Option, pipe, Schema } from "effect";

import {
  boardCountsStatement,
  claimIngestStatement,
  claimNeuronsStatement,
  clearSkipStatement,
  companyHistoryStatement,
  companyJobsStatement,
  companySummaryStatement,
  companyOpenRolesStatement,
  countJobsStatement,
  feedFailedStatement,
  feedHealthStatement,
  feedStatesStatement,
  feedSucceededStatement,
  findJobStatement,
  historyStatement,
  intelSightingStatements,
  lastRunStatement,
  listJobsStatement,
  heldListingsStatement,
  markListedStatement,
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
  releaseIngestStatement,
  departUnseenStatement,
  BOARD_MODEL_PREFIX,
  saveBoardFactsStatement,
  saveEnrichmentStatement,
  sightingStatement,
  sitemapJobsStatement,
  TOP_COMPANIES,
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

const HeldListingRow = Schema.Struct({ id: Schema.String });

const CompanySummaryRow = Schema.Struct({
  opened_at: Schema.NullOr(Count),
  total: Count,
});

const EnrichedJobRow = Schema.Struct({
  ...JobRow.fields,
  board: Schema.NullOr(Schema.String),
  enriched_at: Schema.NullOr(Count),
  hands_on: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  prompt_version: Schema.NullOr(Count),
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
  departed_at: Schema.NullOr(Count),
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
  company: Schema.String,
  last_seen_at: Count,
  last_seen_feed: Schema.String,
  previous_ended_at: Schema.NullOr(Count),
  previous_started_at: Schema.NullOr(Count),
  stint_started_at: Count,
});

const historyRecordOfRow = (
  row: typeof CompanyHistoryRow.Type
): HistoryRecord => ({
  company: row.company,
  feed: row.last_seen_feed,
  stints: [
    { from: row.stint_started_at, until: row.last_seen_at },
    ...(row.previous_started_at === null || row.previous_ended_at === null
      ? []
      : [{ from: row.previous_started_at, until: row.previous_ended_at }]),
  ],
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

const BoardCountRow = Schema.Struct({
  company: Schema.NullOr(Schema.String),
  deduped: Count,
  listed: Count,
  region: Region,
  role: RoleLevel,
  slug: Schema.String,
});

type BoardCountRowValue = typeof BoardCountRow.Type;

const SitemapJobRow = Schema.Struct({
  company: Schema.String,
  first_seen_at: Count,
  id: Schema.String,
  region: Region,
  role: RoleLevel,
});

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
          board: row.board,
          enrichedAt: row.enriched_at,
          handsOn: row.hands_on,
          model: row.model.startsWith(BOARD_MODEL_PREFIX) ? null : row.model,
          promptVersion: row.prompt_version,
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
      status: listingStatus(
        {
          departedAt: row.departed_at,
          firstSeenAt: row.first_seen_at,
          postedAt: row.posted_at,
        },
        now
      ),
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

const sumOf = (
  rows: readonly BoardCountRowValue[],
  column: "deduped" | "listed"
) => rows.reduce((sum, row) => sum + row[column], 0);

const countedBy = <Fact>(
  rows: readonly BoardCountRowValue[],
  keyOf: (row: BoardCountRowValue) => string,
  column: "deduped" | "listed",
  factOf: (row: BoardCountRowValue) => Fact
) =>
  Object.values(Array.groupBy(rows, keyOf))
    .map((group) => ({ ...factOf(group[0]), count: sumOf(group, column) }))
    .filter(({ count }) => count > 0)
    .toSorted((left, right) => right.count - left.count);

const topCompaniesOf = (rows: readonly BoardCountRowValue[]) =>
  Object.values(
    Array.groupBy(
      rows.filter(({ deduped, slug }) => deduped > 0 && slug !== ""),
      ({ slug }) => slug
    )
  )
    .map((group) => ({
      company: group.map(({ company }) => company ?? "").toSorted()[0] ?? "",
      count: sumOf(group, "deduped"),
      slug: group[0].slug,
    }))
    .toSorted(
      (left, right) =>
        right.count - left.count || (left.slug < right.slug ? -1 : 1)
    )
    .slice(0, TOP_COMPANIES);

const boardCountsOf = (rows: readonly BoardCountRowValue[]) => ({
  activeJobs: sumOf(rows, "listed"),
  companies: topCompaniesOf(rows),
  placements: countedBy(
    rows,
    ({ region, role }) => `${role} ${region}`,
    "deduped",
    ({ region, role }) => ({ region, role })
  ),
  regions: countedBy(
    rows,
    ({ region }) => region,
    "listed",
    ({ region }) => ({ region })
  ),
  roles: countedBy(
    rows,
    ({ role }) => role,
    "listed",
    ({ role }) => ({ role })
  ),
});

const totalOf = (rows: readonly (typeof TotalRow.Type)[]) =>
  Option.match(Array.head(rows), {
    onNone: () => 0,
    onSome: (row) => row.total,
  });

export const makeJobStore = Effect.gen(function* makeJobStore() {
  const sql = yield* SqlExecutor;

  const findJob = (id: string, includeDeparted: boolean) =>
    sql
      .all("findJob", findJobStatement(id, includeDeparted), EnrichedJobRow)
      .pipe(
        Effect.flatMap((rows) =>
          Effect.transposeOption(
            Option.map(Array.head(rows), jobDetailOfRow("findJob"))
          )
        )
      );

  return JobStore.of({
    claimIngest: (startedAt, heldUntil) =>
      sql
        .batch("claimIngest", [claimIngestStatement(startedAt, heldUntil)])
        .pipe(Effect.map(([claim]) => claim?.changes === 1)),

    claimNeurons: (claim) =>
      sql
        .batch("claimNeurons", [claimNeuronsStatement(claim)])
        .pipe(Effect.map(([claimed]) => claimed?.changes === 1)),

    companyJobs: (slug, now) =>
      Effect.all(
        {
          rows: sql.all(
            "companyJobs",
            companyJobsStatement(slug, now),
            ListedJobRow
          ),
          totals: sql.all(
            "companySummary",
            companySummaryStatement(slug, now),
            CompanySummaryRow
          ),
        },
        { concurrency: 2 }
      ).pipe(
        Effect.flatMap(({ rows, totals }) =>
          Effect.all(rows.map(jobDetailOfRow("companyJobs"))).pipe(
            Effect.map((jobs) => {
              const total = totals[0]?.total ?? 0;
              const openedAt = totals[0]?.opened_at ?? now;

              return {
                jobs,
                summary: {
                  longestOpenDays: daysOpen(openedAt, now),
                  openRoles: total,
                },
                total,
              };
            })
          )
        )
      ),

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
          history: history.map(historyRecordOfRow),
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

    find: (id) => findJob(id, false),

    findIncludingDeparted: (id) => findJob(id, true),

    heldListings: (feedKey, ids) =>
      ids.length === 0
        ? Effect.succeed([])
        : sql
            .all(
              "heldListings",
              heldListingsStatement(feedKey, ids),
              HeldListingRow
            )
            .pipe(Effect.map(Array.map((row) => row.id))),

    historyOf: (job) =>
      sql
        .all("historyOf", historyStatement(job), HistoryRow)
        .pipe(Effect.map((rows) => Option.map(Array.head(rows), historyOfRow))),
    list: (query, now, sources) =>
      Effect.all(
        {
          rows: sql.all(
            "listJobs",
            listJobsStatement(query, now, sources),
            ListedJobRow
          ),
          total: sql.all(
            "countJobs",
            countJobsStatement(query, now, sources),
            TotalRow
          ),
        },
        { concurrency: 2 }
      ).pipe(
        Effect.flatMap(({ rows, total }) =>
          pipe(rows, Array.map(listedJobOfRow(now)), Effect.all).pipe(
            Effect.map((jobs) => ({ jobs, total: totalOf(total) }))
          )
        )
      ),

    markListed: (feedKey, ids, seenAt) =>
      ids.length === 0
        ? Effect.void
        : sql
            .batch(
              "markListed",
              pipe(
                Array.chunksOf(ids, UPSERT_CHUNK),
                Array.map((chunk) =>
                  markListedStatement(feedKey, chunk, seenAt)
                )
              )
            )
            .pipe(Effect.asVoid),

    neuronsClaimed: (day) =>
      sql.all("neuronsClaimed", neuronsClaimedStatement(day), TotalRow).pipe(
        Effect.map((rows) =>
          Option.match(Array.head(rows), {
            onNone: () => 0,
            onSome: (row) => row.total,
          })
        )
      ),

    prune: (retention) =>
      sql
        .batch("prune", [
          pruneJobsStatement(retention),
          pruneRunsStatement(retention.unseenBefore),
          pruneOrphanEnrichmentStatement,
          pruneOrphanSkipStatement,
          pruneNeuronsStatement(retention.unseenBefore),
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
              Array.flatMap((listing) => [
                sightingStatement(listing, seenAt),
                ...intelSightingStatements(listing, seenAt),
              ])
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

    replaceFeed: (feedKey, jobs, seenAt, departPostedBefore = EVERY_POSTING) =>
      Effect.gen(function* replaceFeed() {
        const chunks = pipe(
          Array.chunksOf(jobs, UPSERT_CHUNK),
          Array.map(
            Array.flatMap((job) => [
              upsertJobStatement(job),
              sightingStatement(job, seenAt),
              ...intelSightingStatements(job, seenAt),
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

        const [departed] = yield* sql.batch("replaceFeed", [
          departUnseenStatement(feedKey, seenAt, departPostedBefore),
          feedSucceededStatement(feedKey, seenAt),
        ]);

        return { departed: departed?.changes ?? 0, upserted: jobs.length };
      }),

    saveBoardFacts: (rows, seenAt) =>
      Effect.forEach(
        Array.chunksOf(rows, UPSERT_CHUNK),
        (chunk) =>
          sql.batch(
            "saveBoardFacts",
            chunk.map((row) => saveBoardFactsStatement(row, seenAt))
          ),
        { discard: true }
      ),

    saveEnrichment: (id, enrichment) =>
      sql
        .batch("saveEnrichment", [
          saveEnrichmentStatement(id, enrichment),
          clearSkipStatement(id),
        ])
        .pipe(Effect.asVoid),

    sitemapJobs: (now, sources) =>
      sql
        .all("sitemapJobs", sitemapJobsStatement(now, sources), SitemapJobRow)
        .pipe(
          Effect.map(
            Array.map(({ first_seen_at, ...job }) => ({
              ...job,
              firstSeenAt: first_seen_at,
            }))
          )
        ),

    stats: (now, sources, catalogKeys) =>
      Effect.all(
        {
          counts: sql.all(
            "boardCounts",
            boardCountsStatement(now, sources),
            BoardCountRow
          ),
          feeds: sql.all(
            "feedHealth",
            feedHealthStatement(catalogKeys),
            FeedHealthRow
          ),
          lastRun: sql.all("lastRun", lastRunStatement, RunRow),
          newToday: sql.all(
            "newToday",
            newTodayStatement(now, sources),
            TotalRow
          ),
        },
        { concurrency: 3 }
      ).pipe(
        Effect.map(({ counts, feeds, lastRun, newToday }) => {
          const health = Array.head(feeds);

          return {
            ...boardCountsOf(counts),
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
