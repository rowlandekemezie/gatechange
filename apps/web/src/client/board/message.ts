import { Schema } from "effect";
import { BoardStats, Job, JobPage, RoleLevel } from "@rat-stack/core/contracts";
import { defineMessageUnion } from "foldkit/message";

import { AgeWindow, RegionGroup, Sort } from "./filters.js";
import { MarkKind, Shortlist, View } from "./model.js";

export const Message = defineMessageUnion({
  ChangedAge: { maxAgeDays: AgeWindow },
  ChangedSort: { sort: Sort },
  ChangedView: { view: View },
  ClickedClearMark: { id: Schema.String },
  ClickedLoadMore: {},
  ClickedMark: { job: Job, kind: MarkKind },
  ClickedResetFilters: {},
  ClickedRetry: {},
  CompletedReadShortlist: { marks: Shortlist },
  CompletedWriteShortlist: {},
  FailedFetchJobs: { generation: Schema.Finite, message: Schema.String },
  FailedFetchMoreJobs: { generation: Schema.Finite },
  FailedFetchStats: {},
  SubmittedSearch: {},
  SucceededFetchJobs: { generation: Schema.Finite, page: JobPage },
  SucceededFetchMoreJobs: { generation: Schema.Finite, page: JobPage },
  SucceededFetchStats: { stats: BoardStats },
  ToggledRegionGroup: { group: RegionGroup },
  ToggledRole: { role: RoleLevel },
  UpdatedDraftSearch: { value: Schema.String },
});

export type Message = typeof Message.Type;
