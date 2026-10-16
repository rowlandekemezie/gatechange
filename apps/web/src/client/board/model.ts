import { Schema } from "effect";
import { BoardStats, Job } from "@rat-stack/core/contracts";
import { defineTaggedUnion } from "foldkit/schema";

import { defaultFilters, Filters } from "./filters.js";

export const JobsState = defineTaggedUnion({
  Failed: { message: Schema.String },
  Loaded: { generatedAt: Schema.Finite, jobs: Schema.Array(Job), total: Schema.Finite },
  Loading: {},
});

export const MoreState = defineTaggedUnion({
  Failed: {},
  Idle: {},
  Loading: {},
});

export const StatsState = defineTaggedUnion({
  Loaded: { stats: BoardStats },
  Unavailable: {},
});

export const MarkKind = Schema.Literals(["Saved", "Applied"]);

export type MarkKindValue = typeof MarkKind.Type;

export const MarkedJob = Schema.Struct({
  company: Schema.String,
  id: Schema.String,
  kind: MarkKind,
  location: Schema.String,
  title: Schema.String,
  url: Schema.String,
});

export type MarkedJobValue = typeof MarkedJob.Type;

export const Shortlist = Schema.Array(MarkedJob);

export const View = Schema.Literals(["Board", "Shortlist"]);

export const Model = Schema.Struct({
  draftSearch: Schema.String,
  filters: Filters,
  generation: Schema.Finite,
  jobs: JobsState,
  marks: Shortlist,
  more: MoreState,
  stats: StatsState,
  view: View,
});

export type ModelValue = typeof Model.Type;

export const initialModel: ModelValue = {
  draftSearch: "",
  filters: defaultFilters,
  generation: 0,
  jobs: JobsState.Loading(),
  marks: [],
  more: MoreState.Idle(),
  stats: StatsState.Unavailable(),
  view: "Board",
};
