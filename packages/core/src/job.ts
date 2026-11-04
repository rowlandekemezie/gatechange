import { Effect, Schema } from "effect";

export const RoleLevel = Schema.Literals([
  "VicePresident",
  "HeadOfEngineering",
  "Director",
  "EngineeringManager",
]);

export type RoleLevelValue = typeof RoleLevel.Type;

export const roleLevels: readonly RoleLevelValue[] = RoleLevel.literals;

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

export type RegionValue = typeof Region.Type;

export const regions: readonly RegionValue[] = Region.literals;

export const Arrangement = Schema.Literals([
  "Remote",
  "Hybrid",
  "Onsite",
  "Unspecified",
]);

export type ArrangementValue = typeof Arrangement.Type;

export const SourceName = Schema.Literals([
  "Greenhouse",
  "Lever",
  "Ashby",
  "Workable",
  "SmartRecruiters",
  "RemoteOK",
  "Remotive",
  "Himalayas",
  "Jobicy",
  "HackerNews",
]);

export type SourceNameValue = typeof SourceName.Type;

export const EpochMillis = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0)
);

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

export type JobValue = typeof Job.Type;

export const Currency = Schema.Literals(["USD", "CAD", "EUR", "GBP"]);

export type CurrencyValue = typeof Currency.Type;

export const currencies: readonly CurrencyValue[] = Currency.literals;

export const AnnualAmount = Schema.Int.check(
  Schema.isBetween({ maximum: 5_000_000, minimum: 10_000 })
);

export const SalaryBand = Schema.Struct({
  currency: Currency,
  max: AnnualAmount,
  min: AnnualAmount,
}).check(
  Schema.makeFilter((band) => band.min <= band.max || "min must not exceed max")
);

export type SalaryBandValue = typeof SalaryBand.Type;

export const Seniority = Schema.Literals([
  "Manager",
  "SeniorManager",
  "Director",
  "SeniorDirector",
  "VicePresident",
  "Executive",
]);

export type SeniorityValue = typeof Seniority.Type;

export const seniorities: readonly SeniorityValue[] = Seniority.literals;

export const RemotePolicy = Schema.Literals([
  "Remote",
  "RemoteInRegion",
  "Hybrid",
  "Onsite",
]);

export type RemotePolicyValue = typeof RemotePolicy.Type;

export const HandsOn = Schema.Literals(["None", "Some", "Significant"]);

export type HandsOnValue = typeof HandsOn.Type;

export const ListingDetails = Schema.Struct({
  handsOn: Schema.NullOr(HandsOn),
  remotePolicy: Schema.NullOr(RemotePolicy),
  reportsTo: Schema.NullOr(
    Schema.NonEmptyString.check(Schema.isMaxLength(120))
  ),
  salary: Schema.NullOr(SalaryBand),
  seniority: Schema.NullOr(Seniority),
  teamSize: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 1 }))
  ),
});

export type ListingDetailsValue = typeof ListingDetails.Type;

export const Enrichment = Schema.Struct({
  ...ListingDetails.fields,
  board: Schema.NullOr(SourceName),
  enrichedAt: EpochMillis,
  model: Schema.NullOr(Schema.NonEmptyString),
  promptVersion: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
}).check(
  Schema.makeFilter(
    (enrichment) =>
      enrichment.board !== null ||
      enrichment.model !== null ||
      "an enrichment needs a board or a model"
  )
);

export type EnrichmentValue = typeof Enrichment.Type;

export const JobDetail = Schema.Struct({
  ...Job.fields,
  enrichment: Schema.NullOr(Enrichment),
});

export type JobDetailValue = typeof JobDetail.Type;

export const JobSort = Schema.Literals(["Relevance", "Newest"]);

export type JobSortValue = typeof JobSort.Type;

export const ADMISSION_DAYS = 30;

export const MAX_AGE_DAYS = 3650;

export const DEFAULT_AGE_DAYS = 7;

export const MAX_PAGE_SIZE = 100;

export const SalaryFloor = Schema.Struct({
  amount: AnnualAmount,
  currency: Currency,
});

export type SalaryFloorValue = typeof SalaryFloor.Type;

export const JobQuery = Schema.Struct({
  limit: Schema.Int.check(
    Schema.isBetween({ maximum: MAX_PAGE_SIZE, minimum: 1 })
  ),
  maxAgeDays: Schema.Int.check(
    Schema.isBetween({ maximum: MAX_AGE_DAYS, minimum: 1 })
  ),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  regions: Schema.Array(Region),
  roles: Schema.Array(RoleLevel),
  salaryFloor: Schema.NullOr(SalaryFloor).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  salaryListed: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  search: Schema.String.check(Schema.isMaxLength(80)),
  seniorities: Schema.Array(Seniority).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  sort: JobSort,
});

export type JobQueryValue = typeof JobQuery.Type;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ListingStatus = Schema.Literals([
  "new",
  "boarding",
  "on_time",
  "departed",
]);

export type ListingStatusValue = typeof ListingStatus.Type;

export const ListedJob = Schema.Struct({
  ...JobDetail.fields,
  daysOpen: Count,
  reposts: Count,
  status: ListingStatus,
});

export type ListedJobValue = typeof ListedJob.Type;

export const JobPage = Schema.Struct({
  generatedAt: EpochMillis,
  jobs: Schema.Array(ListedJob),
  total: Count,
});

export type JobPageValue = typeof JobPage.Type;

export const RegionCount = Schema.Struct({
  count: Schema.Int,
  region: Region,
});

export const RoleCount = Schema.Struct({
  count: Schema.Int,
  role: RoleLevel,
});

export const PlacementCount = Schema.Struct({
  count: Schema.Int,
  region: Region,
  role: RoleLevel,
});

export const CompanyCount = Schema.Struct({
  company: Schema.String,
  count: Schema.Int,
  slug: Schema.String,
});

export const IngestOutcome = Schema.Literals([
  "Succeeded",
  "Partial",
  "Failed",
]);

export const IngestReceipt = Schema.Struct({
  feedsAttempted: Schema.Int,
  feedsFailed: Schema.Int,
  finishedAt: EpochMillis,
  jobsPruned: Schema.Int,
  jobsUpserted: Schema.Int,
  outcome: IngestOutcome,
  startedAt: EpochMillis,
});

export type IngestReceiptValue = typeof IngestReceipt.Type;

export const BoardStats = Schema.Struct({
  activeJobs: Schema.Int,
  companies: Schema.Array(CompanyCount),
  feedsFailing: Schema.Int,
  feedsTotal: Schema.Int,
  generatedAt: EpochMillis,
  lastRun: Schema.NullOr(IngestReceipt),
  newToday: Schema.Int,
  placements: Schema.Array(PlacementCount),
  regions: Schema.Array(RegionCount),
  roles: Schema.Array(RoleCount),
});

export type BoardStatsValue = typeof BoardStats.Type;

export const SitemapJob = Schema.Struct({
  company: Schema.String,
  firstSeenAt: EpochMillis,
  id: Schema.String,
  region: Region,
  role: RoleLevel,
});

export type SitemapJobValue = typeof SitemapJob.Type;
