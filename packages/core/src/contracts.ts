import { defineContract } from "@rat-stack/capability/contract";
import { Schema } from "effect";

import { JobStoreUnavailable } from "./job-store-unavailable.js";
import { BoardStats, JobPage, JobQuery } from "./job.js";

export {
  Arrangement,
  BoardStats,
  DEFAULT_AGE_DAYS,
  EpochMillis,
  IngestOutcome,
  IngestReceipt,
  Job,
  JobPage,
  JobQuery,
  JobSort,
  ListedJob,
  MAX_AGE_DAYS,
  MAX_PAGE_SIZE,
  Region,
  RegionCount,
  RoleCount,
  RoleLevel,
  SourceName,
  regions,
  roleLevels,
} from "./job.js";

export type {
  ArrangementValue,
  BoardStatsValue,
  IngestReceiptValue,
  JobPageValue,
  JobQueryValue,
  JobSortValue,
  JobValue,
  ListedJobValue,
  RegionValue,
  RoleLevelValue,
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

export const jobBoardContracts = [
  listJobsContract,
  boardStatsContract,
] as const;
