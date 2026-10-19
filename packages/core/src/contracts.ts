import { defineContract } from "@rat-stack/capability/contract";
import { Schema } from "effect";

import { Account, SignInOptions } from "./account.js";
import { AgentTokenLimit } from "./agent-token-limit.js";
import {
  AgentToken,
  AgentTokenId,
  AgentTokenLabel,
  IssuedAgentToken,
} from "./agent-token.js";
import { SavedSearch, SavedSearchId, SearchFilters } from "./alerts.js";
import { AlreadyPro } from "./already-pro.js";
import { BillingUnavailable } from "./billing-unavailable.js";
import { Membership, Plan } from "./entitlement.js";
import { JobStoreUnavailable } from "./job-store-unavailable.js";
import { BoardStats, Job, JobPage, JobQuery } from "./job.js";
import { NoBillingAccount } from "./no-billing-account.js";
import { ProRequired } from "./pro-required.js";
import { SavedSearchLimit } from "./saved-search-limit.js";
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

export { offSiteHref } from "./site.js";

export {
  AgentToken,
  AgentTokenId,
  AgentTokenLabel,
  IssuedAgentToken,
  MAX_AGENT_TOKEN_LABEL_LENGTH,
  MAX_AGENT_TOKENS,
} from "./agent-token.js";

export type {
  AgentTokenIdValue,
  AgentTokenValue,
  IssuedAgentTokenValue,
} from "./agent-token.js";

export { AgentTokenLimit } from "./agent-token-limit.js";

export {
  ANONYMOUS_MCP_CALLS_PER_MINUTE,
  MCP_DISCOVERY_PATH,
  MCP_PATH,
  TOKEN_MCP_CALLS_PER_MINUTE,
} from "./agent-access.js";

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

export { AlreadyPro } from "./already-pro.js";

export { BillingFailure } from "./billing-errors.js";

export type { BillingFailureValue } from "./billing-errors.js";

export { BillingUnavailable } from "./billing-unavailable.js";

export { NoBillingAccount } from "./no-billing-account.js";

export { ProRequired } from "./pro-required.js";

export {
  Entitlement,
  FREE,
  FreeEntitlement,
  isPro,
  Membership,
  Plan,
  PLAN_PRICES,
  plans,
  ProEntitlement,
} from "./entitlement.js";

export type {
  EntitlementValue,
  MembershipValue,
  PlanPrice,
  PlanValue,
} from "./entitlement.js";

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

const BillingLink = Schema.Struct({ url: Schema.NonEmptyString });

export const membershipContract = defineContract("membership", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "Return the signed-in member's plan, Free or Pro with its period end, and whether instant alerts are on",
  failure: MemberStoreFailure,
  input: Schema.Struct({}),
  output: Membership,
});

export const startCheckoutContract = defineContract("startCheckout", {
  description:
    "Start a Stripe Checkout for Pro on the monthly, quarterly, or yearly plan and return the hosted payment page URL",
  failure: Schema.Union([
    Unauthorized,
    JobStoreUnavailable,
    BillingUnavailable,
    AlreadyPro,
  ]),
  input: Schema.Struct({ plan: Plan }),
  output: BillingLink,
});

export const openBillingPortalContract = defineContract("openBillingPortal", {
  description:
    "Return a Stripe billing portal URL where the signed-in member can change or cancel Pro",
  failure: Schema.Union([
    Unauthorized,
    JobStoreUnavailable,
    BillingUnavailable,
    NoBillingAccount,
  ]),
  input: Schema.Struct({}),
  output: BillingLink,
});

export const setInstantAlertsContract = defineContract("setInstantAlerts", {
  annotations: { idempotent: true },
  description:
    "Turn instant alerts on or off for a Pro member's saved searches and return the membership",
  failure: Schema.Union([Unauthorized, JobStoreUnavailable, ProRequired]),
  input: Schema.Struct({ enabled: Schema.Boolean }),
  output: Membership,
});

export const agentTokensContract = defineContract("agentTokens", {
  annotations: { idempotent: true, readOnly: true },
  description:
    "List the signed-in member's personal tokens for AI agents, newest first, without their secrets",
  failure: MemberStoreFailure,
  input: Schema.Struct({}),
  output: Schema.Array(AgentToken),
});

export const issueAgentTokenContract = defineContract("issueAgentToken", {
  description:
    "Issue a Pro member a personal token that lets an AI agent use the Pro tools over MCP, and return its secret once",
  failure: Schema.Union([
    Unauthorized,
    JobStoreUnavailable,
    ProRequired,
    AgentTokenLimit,
  ]),
  input: Schema.Struct({ label: AgentTokenLabel }),
  output: IssuedAgentToken,
});

export const revokeAgentTokenContract = defineContract("revokeAgentToken", {
  annotations: { destructive: true, idempotent: true },
  description:
    "Revoke one of the signed-in member's agent tokens so every agent using it is refused",
  failure: MemberStoreFailure,
  input: Schema.Struct({ id: AgentTokenId }),
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
  trackedJobsContract,
  trackJobContract,
  importShortlistContract,
  noteTrackedJobContract,
  untrackJobContract,
  membershipContract,
  startCheckoutContract,
  openBillingPortalContract,
  setInstantAlertsContract,
  agentTokensContract,
  issueAgentTokenContract,
  revokeAgentTokenContract,
] as const;
