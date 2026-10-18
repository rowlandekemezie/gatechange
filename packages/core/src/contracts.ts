import { defineContract } from "@rat-stack/capability/contract";
import { Schema } from "effect";

import { Account, SignInOptions } from "./account.js";
import { SavedSearch, SavedSearchId, SearchFilters } from "./alerts.js";
import { JobStoreUnavailable } from "./job-store-unavailable.js";
import { BoardStats, Job, JobPage, JobQuery } from "./job.js";
import { SavedSearchLimit } from "./saved-search-limit.js";
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

export { isOffSiteWebUrl } from "./site.js";

export { Unauthorized } from "./unauthorized.js";

export {
  DigestFrequency,
  digestSourceLabels,
  MAX_SAVED_SEARCHES,
  SavedSearch,
  SavedSearchId,
  SearchFilters,
} from "./alerts.js";

export { SavedSearchLimit } from "./saved-search-limit.js";

export type {
  DigestFrequencyValue,
  SavedSearchIdValue,
  SavedSearchValue,
  SearchFiltersValue,
} from "./alerts.js";

export type {
  AccountIdValue,
  AccountValue,
  SignInOptionsValue,
  SocialProviderValue,
} from "./account.js";

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

const MemberStoreFailure = Schema.Union([Unauthorized, JobStoreUnavailable]);

export const saveSearchContract = defineContract("saveSearch", {
  description:
    "Save the signed-in member's board filters as a search that a weekly email digest reports new matches for",
  failure: Schema.Union([Unauthorized, JobStoreUnavailable, SavedSearchLimit]),
  input: Schema.Struct({ filters: SearchFilters }),
  output: SavedSearch,
});

export const savedSearchesContract = defineContract("savedSearches", {
  annotations: { idempotent: true, readOnly: true },
  description: "List the signed-in member's saved searches, newest first",
  failure: MemberStoreFailure,
  input: Schema.Struct({}),
  output: Schema.Array(SavedSearch),
});

export const deleteSearchContract = defineContract("deleteSearch", {
  annotations: { destructive: true, idempotent: true },
  description:
    "Delete one of the signed-in member's saved searches so it stops producing digests",
  failure: MemberStoreFailure,
  input: Schema.Struct({ id: SavedSearchId }),
  output: Schema.Void,
});

export const jobBoardContracts = [
  listJobsContract,
  boardStatsContract,
  getJobContract,
  accountContract,
  signInOptionsContract,
  saveSearchContract,
  savedSearchesContract,
  deleteSearchContract,
] as const;
