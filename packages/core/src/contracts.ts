import { defineContract } from "@rat-stack/capability/contract";
import { Schema } from "effect";

import { JobStoreUnavailable } from "./job-store-unavailable.js";
import { BoardStats, JobDetail, JobPage, JobQuery } from "./job.js";

export {
  AnnualAmount,
  Arrangement,
  BoardStats,
  currencies,
  Currency,
  DEFAULT_AGE_DAYS,
  Enrichment,
  EpochMillis,
  IngestOutcome,
  IngestReceipt,
  Job,
  JobDetail,
  JobPage,
  JobQuery,
  JobSort,
  ListedJob,
  ListingDetails,
  MAX_AGE_DAYS,
  MAX_PAGE_SIZE,
  Region,
  RegionCount,
  RemotePolicy,
  RoleCount,
  RoleLevel,
  SalaryBand,
  SalaryFloor,
  Seniority,
  seniorities,
  SourceName,
  regions,
  roleLevels,
} from "./job.js";

export type {
  ArrangementValue,
  BoardStatsValue,
  CurrencyValue,
  EnrichmentValue,
  IngestReceiptValue,
  JobDetailValue,
  JobPageValue,
  JobQueryValue,
  JobSortValue,
  JobValue,
  ListedJobValue,
  ListingDetailsValue,
  RegionValue,
  RemotePolicyValue,
  RoleLevelValue,
  SalaryBandValue,
  SalaryFloorValue,
  SeniorityValue,
  SourceNameValue,
} from "./job.js";

export { JobStoreUnavailable } from "./job-store-unavailable.js";

export { Permission, SourceTerms } from "./source-terms.js";

export type { PermissionValue, SourceTermsValue } from "./source-terms.js";

export const listJobsContract = defineContract("listJobs", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "List engineering leadership roles posted within the last 1 to 30 days, filtered by role level, region, and a text search",
  failure: JobStoreUnavailable,
  input: JobQuery,
  output: JobPage,
});

export const boardStatsContract = defineContract("boardStats", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "Count active roles by region and level, and report the most recent ingest run and feed health",
  failure: JobStoreUnavailable,
  input: Schema.Struct({}),
  output: BoardStats,
});

export const getJobContract = defineContract("getJob", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "Fetch one listed role by its id, or nothing when its source removed it or it aged off the board",
  failure: JobStoreUnavailable,
  input: Schema.Struct({ id: Schema.NonEmptyString }),
  output: Schema.OptionFromNullOr(JobDetail),
});

export const jobBoardContracts = [
  listJobsContract,
  boardStatsContract,
  getJobContract,
] as const;
