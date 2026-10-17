import { BoardStats, Job, JobPage, RoleLevel } from "@rat-stack/core/contracts";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";

import { AgeWindow, RegionGroup, Sort } from "./filters.js";
import { MarkKind, Shortlist } from "./model.js";

export const Message = defineMessageUnion({
  ChangedAge: { maxAgeDays: AgeWindow },
  ChangedSort: { sort: Sort },
  ChangedUrl: { url: Url },
  ClickedClearMark: { id: Schema.String },
  ClickedLink: { request: UrlRequest },
  ClickedLoadMore: {},
  ClickedMark: { job: Job, kind: MarkKind },
  ClickedResetFilters: {},
  ClickedRetry: {},
  ClickedRetryJob: {},
  CompletedNavigation: {},
  CompletedReadShortlist: { marks: Shortlist },
  CompletedWriteShortlist: {},
  FailedFetchJob: { id: Schema.String, message: Schema.String },
  FailedFetchJobs: { generation: Schema.Finite, message: Schema.String },
  FailedFetchMoreJobs: { generation: Schema.Finite },
  FailedFetchStats: {},
  SubmittedSearch: {},
  SucceededFetchJob: { id: Schema.String, job: Schema.Option(Job) },
  SucceededFetchJobs: { generation: Schema.Finite, page: JobPage },
  SucceededFetchMoreJobs: { generation: Schema.Finite, page: JobPage },
  SucceededFetchStats: { stats: BoardStats },
  ToggledRegionGroup: { group: RegionGroup },
  ToggledRole: { role: RoleLevel },
  UpdatedDraftSearch: { value: Schema.String },
});

export type MessageValue = typeof Message.Type;
