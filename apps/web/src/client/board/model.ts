import {
  BoardStats,
  Job,
  Stage,
  TrackedJob,
  TrackRequest,
} from "@rat-stack/core/contracts";
import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { Model as AccountModel } from "../account/model.js";
import { Route } from "../route.js";
import { Filters } from "./filters.js";

export const JobsState = defineTaggedUnion({
  Failed: { message: Schema.String },
  Loaded: {
    generatedAt: Schema.Finite,
    jobs: Schema.Array(Job),
    total: Schema.Finite,
  },
  Loading: {},
  NotAsked: {},
});

export const JobState = defineTaggedUnion({
  Failed: { id: Schema.String, message: Schema.String },
  Found: { job: Job },
  Loading: { id: Schema.String },
  Missing: { id: Schema.String },
  NotAsked: {},
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

export const PendingTrack = Schema.Struct({
  jobId: Schema.String,
  stage: Stage,
});

export const TrackerState = defineTaggedUnion({
  Local: {},
  Remote: {
    adding: Schema.Array(PendingTrack),
    jobs: Schema.Array(TrackedJob),
    loaded: Schema.Boolean,
    problem: Schema.Option(Schema.String),
  },
});

export type TrackerStateValue = typeof TrackerState.Type;

export type RemoteTrackerValue = Extract<
  TrackerStateValue,
  { readonly _tag: "Remote" }
>;

export const TrackerChange = defineTaggedUnion({
  Note: { jobId: Schema.String, notes: Schema.String },
  Track: { job: TrackRequest },
  Untrack: { jobId: Schema.String },
});

export type TrackerChangeValue = typeof TrackerChange.Type;

export const Model = Schema.Struct({
  account: AccountModel,
  awaitingEcho: Schema.Array(Schema.String),
  draftSearch: Schema.String,
  filters: Filters,
  generation: Schema.Finite,
  job: JobState,
  jobs: JobsState,
  marks: Shortlist,
  more: MoreState,
  route: Route,
  stats: StatsState,
  tracker: TrackerState,
  trackerRevision: Schema.Finite,
});

export type ModelValue = typeof Model.Type;
