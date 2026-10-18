import { defineContract } from "@rat-stack/capability/contract";
import { Schema } from "effect";

import { Account, SignInOptions } from "./account.js";
import { JobStoreUnavailable } from "./job-store-unavailable.js";
import { BoardStats, Job, JobPage, JobQuery } from "./job.js";
import { TrackerFull } from "./tracker-full.js";
import {
  ImportShortlist,
  Notes,
  TrackedJobs,
  TrackRequest,
} from "./tracker.js";
import { Unauthorized } from "./unauthorized.js";

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

export {
  Account,
  AccountId,
  MAGIC_LINK_TTL_MINUTES,
  SignInOptions,
  SocialProvider,
} from "./account.js";

export { Unauthorized } from "./unauthorized.js";

export type {
  AccountIdValue,
  AccountValue,
  SignInOptionsValue,
  SocialProviderValue,
} from "./account.js";

export { JobStoreUnavailable } from "./job-store-unavailable.js";

export {
  JobSnapshot,
  MAX_IMPORTED_JOBS,
  MAX_NOTES_LENGTH,
  Stage,
  stages,
  TRACKER_LIMIT,
  TrackedJob,
  TrackedJobs,
  TrackRequest,
} from "./tracker.js";

export { TrackerFull } from "./tracker-full.js";

export type {
  JobSnapshotValue,
  StageValue,
  TrackedJobValue,
  TrackRequestValue,
} from "./tracker.js";

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
  output: Schema.OptionFromNullOr(Job),
});

export const accountContract = defineContract("account", {
  annotations: { idempotent: true, readOnly: true },
  description: "Return the signed-in member's account, or Unauthorized",
  failure: Unauthorized,
  input: Schema.Struct({}),
  output: Account,
});

export const signInOptionsContract = defineContract("signInOptions", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "List the social providers a viewer can sign in with besides an emailed link",
  failure: Schema.Never,
  input: Schema.Struct({}),
  output: SignInOptions,
});

const TrackerFailure = Schema.Union([Unauthorized, JobStoreUnavailable]);

const TrackerAddFailure = Schema.Union([
  Unauthorized,
  JobStoreUnavailable,
  TrackerFull,
]);

const TrackedJobKey = Schema.Struct({ jobId: Schema.NonEmptyString });

export const trackedJobsContract = defineContract("trackedJobs", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "List the signed-in member's tracked jobs with their stage, notes, and dates",
  failure: TrackerFailure,
  input: Schema.Struct({}),
  output: TrackedJobs,
});

export const trackJobContract = defineContract("trackJob", {
  annotations: { idempotent: true },
  description:
    "Track a job for the signed-in member at a stage, or move a tracked job to that stage, and return the tracker",
  failure: TrackerAddFailure,
  input: TrackRequest,
  output: TrackedJobs,
});

export const importShortlistContract = defineContract("importShortlist", {
  annotations: { idempotent: true },
  description:
    "Add a browser shortlist to the signed-in member's tracker, skipping jobs already tracked, and return the tracker",
  failure: TrackerAddFailure,
  input: ImportShortlist,
  output: TrackedJobs,
});

export const noteTrackedJobContract = defineContract("noteTrackedJob", {
  annotations: { idempotent: true },
  description:
    "Replace the notes on one of the signed-in member's tracked jobs and return the tracker",
  failure: TrackerFailure,
  input: Schema.Struct({ ...TrackedJobKey.fields, notes: Notes }),
  output: TrackedJobs,
});

export const untrackJobContract = defineContract("untrackJob", {
  annotations: { destructive: true, idempotent: true },
  description:
    "Remove a job from the signed-in member's tracker and return the tracker",
  failure: TrackerFailure,
  input: TrackedJobKey,
  output: TrackedJobs,
});

export const jobBoardContracts = [
  listJobsContract,
  boardStatsContract,
  getJobContract,
  accountContract,
  signInOptionsContract,
  trackedJobsContract,
  trackJobContract,
  importShortlistContract,
  noteTrackedJobContract,
  untrackJobContract,
] as const;
