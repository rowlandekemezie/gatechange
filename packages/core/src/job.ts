import { Schema } from "effect";

export const RoleLevel = Schema.Literals([
  "VicePresident",
  "HeadOfEngineering",
  "Director",
  "EngineeringManager",
]);

export type RoleLevel = typeof RoleLevel.Type;

export const roleLevels: ReadonlyArray<RoleLevel> = RoleLevel.literals;

export const Region = Schema.Literals([
  "RemoteCanada",
  "RemoteNorthAmerica",
  "RemoteUnitedStates",
  "RemoteGlobal",
  "BritishColumbia",
  "CanadaOnsite",
  "UnitedStatesOnsite",
  "Elsewhere",
]);

export type Region = typeof Region.Type;

export const regions: ReadonlyArray<Region> = Region.literals;

export const Arrangement = Schema.Literals([
  "Remote",
  "Hybrid",
  "Onsite",
  "Unspecified",
]);

export type Arrangement = typeof Arrangement.Type;

export const SourceName = Schema.Literals([
  "Greenhouse",
  "Lever",
  "Ashby",
  "RemoteOK",
  "Remotive",
  "Himalayas",
  "Jobicy",
  "HackerNews",
]);

export type SourceName = typeof SourceName.Type;

export const EpochMillis = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const Job = Schema.Struct({
  arrangement: Arrangement,
  company: Schema.NonEmptyString,
  feed: Schema.NonEmptyString,
  firstSeenAt: EpochMillis,
  id: Schema.NonEmptyString,
  lastSeenAt: EpochMillis,
  location: Schema.String,
  postedAt: EpochMillis,
  region: Region,
  relevance: Schema.Finite,
  role: RoleLevel,
  salary: Schema.NullOr(Schema.String),
  source: SourceName,
  title: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
});

export type Job = typeof Job.Type;

export const JobSort = Schema.Literals(["Relevance", "Newest"]);

export type JobSort = typeof JobSort.Type;

export const MAX_AGE_DAYS = 30;

export const DEFAULT_AGE_DAYS = 7;

export const MAX_PAGE_SIZE = 100;

export const JobQuery = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ maximum: MAX_PAGE_SIZE, minimum: 1 })),
  maxAgeDays: Schema.Int.check(Schema.isBetween({ maximum: MAX_AGE_DAYS, minimum: 1 })),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  regions: Schema.Array(Region),
  roles: Schema.Array(RoleLevel),
  search: Schema.String.check(Schema.isMaxLength(80)),
  sort: JobSort,
});

export type JobQuery = typeof JobQuery.Type;

export const JobPage = Schema.Struct({
  generatedAt: EpochMillis,
  jobs: Schema.Array(Job),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type JobPage = typeof JobPage.Type;

export const RegionCount = Schema.Struct({
  count: Schema.Int,
  region: Region,
});

export const RoleCount = Schema.Struct({
  count: Schema.Int,
  role: RoleLevel,
});

export const IngestOutcome = Schema.Literals(["Succeeded", "Partial", "Failed"]);

export const IngestReceipt = Schema.Struct({
  feedsAttempted: Schema.Int,
  feedsFailed: Schema.Int,
  finishedAt: EpochMillis,
  jobsPruned: Schema.Int,
  jobsUpserted: Schema.Int,
  outcome: IngestOutcome,
  startedAt: EpochMillis,
});

export type IngestReceipt = typeof IngestReceipt.Type;

export const BoardStats = Schema.Struct({
  activeJobs: Schema.Int,
  feedsFailing: Schema.Int,
  feedsTotal: Schema.Int,
  generatedAt: EpochMillis,
  lastRun: Schema.NullOr(IngestReceipt),
  newToday: Schema.Int,
  regions: Schema.Array(RegionCount),
  roles: Schema.Array(RoleCount),
});

export type BoardStats = typeof BoardStats.Type;
