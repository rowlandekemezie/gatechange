import {
  BoardStats,
  Job,
  JobPage,
  RoleLevel,
  Stage,
  TrackedJobs,
} from "@rat-stack/core/contracts";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";

import { Message as AccountMessage } from "../account/message.js";
import { Message as AgentTokensMessage } from "../agent-tokens/message.js";
import { Message as BillingMessage } from "../billing/message.js";
import { Listing, ListingRoute } from "../listing.js";
import { Message as SavedSearchesMessage } from "../saved-searches/message.js";
import { AgeWindow, RegionGroup, Sort } from "./filters.js";
import { MarkKind, Shortlist } from "./model.js";

export const Message = defineMessageUnion({
  ChangedAge: { maxAgeDays: AgeWindow },
  ChangedNotes: { jobId: Schema.String, notes: Schema.String },
  ChangedSort: { sort: Sort },
  ChangedStage: { jobId: Schema.String, stage: Stage },
  ChangedUrl: { url: Url },
  ClickedClearMark: { id: Schema.String },
  ClickedKeepShortlist: {},
  ClickedLink: { request: UrlRequest },
  ClickedLoadMore: {},
  ClickedMark: { job: Job, kind: MarkKind },
  ClickedMoveShortlist: {},
  ClickedResetFilters: {},
  ClickedRetry: {},
  ClickedRetryJob: {},
  ClickedRetryListing: {},
  ClickedRetryTracker: {},
  CompletedForgetSignInToken: {},
  CompletedNavigation: {},
  CompletedReadShortlist: { marks: Shortlist },
  CompletedSyncTracker: {
    jobs: TrackedJobs,
    revision: Schema.Finite,
    waiting: Schema.Finite,
  },
  CompletedWriteShortlist: {},
  FailedFetchJob: { id: Schema.String, message: Schema.String },
  FailedFetchJobs: { generation: Schema.Finite, message: Schema.String },
  FailedFetchListing: { message: Schema.String, route: ListingRoute },
  FailedFetchMoreJobs: { generation: Schema.Finite },
  FailedFetchStats: {},
  FailedSyncTracker: { message: Schema.String, revision: Schema.Finite },
  FailedTrackerChange: { message: Schema.String, revision: Schema.Finite },
  GotAccountMessage: { message: AccountMessage },
  GotAgentTokensMessage: { message: AgentTokensMessage },
  GotBillingMessage: { message: BillingMessage },
  GotSavedSearchesMessage: { message: SavedSearchesMessage },
  SubmittedSearch: {},
  SucceededFetchJob: { id: Schema.String, job: Schema.Option(Job) },
  SucceededFetchJobs: { generation: Schema.Finite, page: JobPage },
  SucceededFetchListing: { listing: Listing, route: ListingRoute },
  SucceededFetchMoreJobs: { generation: Schema.Finite, page: JobPage },
  SucceededFetchStats: { stats: BoardStats },
  SucceededTrackerChange: { jobs: TrackedJobs, revision: Schema.Finite },
  ToggledRegionGroup: { group: RegionGroup },
  ToggledRole: { role: RoleLevel },
  ToggledSalaryListed: {},
  UpdatedDraftSearch: { value: Schema.String },
});

export type MessageValue = typeof Message.Type;
