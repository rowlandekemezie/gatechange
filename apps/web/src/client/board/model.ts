import {
  BoardStats,
  CompanySummary,
  EpochMillis,
  JobDetail,
  ListedJob,
  Stage,
  TrackedJob,
  TrackRequest,
} from "@rat-stack/core/contracts";
import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { Model as AccountModel } from "../account/model.js";
import { Model as BillingModel } from "../billing/model.js";
import { ListingRoute } from "../listing.js";
import { Route } from "../route.js";
import { Model as SavedSearchesModel } from "../saved-searches/model.js";
import { Filters } from "./filters.js";

export const JobsState = defineTaggedUnion({
  Failed: { message: Schema.String },
  Loaded: {
    generatedAt: Schema.Finite,
    jobs: Schema.Array(ListedJob),
    total: Schema.Finite,
  },
  Loading: {},
  NotAsked: {},
});

export const JobState = defineTaggedUnion({
  Failed: { id: Schema.String, message: Schema.String },
  Found: { job: JobDetail },
  Loading: { id: Schema.String },
  Missing: { id: Schema.String },
  NotAsked: {},
});

export const ListingState = defineTaggedUnion({
  Failed: { message: Schema.String, route: ListingRoute },
  Loaded: {
    generatedAt: EpochMillis,
    jobs: Schema.Array(JobDetail),
    route: ListingRoute,
    summary: Schema.NullOr(CompanySummary),
    total: Schema.Finite,
  },
  Loading: { route: ListingRoute },
  NotAsked: {},
});

export const Preload = defineTaggedUnion({
  Job: { job: JobDetail },
  JobMissing: {},
  Listing: {
    generatedAt: EpochMillis,
    jobs: Schema.Array(JobDetail),
    summary: Schema.NullOr(CompanySummary),
    total: Schema.Finite,
  },
  Nothing: {},
});

export type PreloadValue = typeof Preload.Type;

export const Flags = Schema.Struct({ origin: Schema.String, preload: Preload });

export type FlagsValue = typeof Flags.Type;

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

export const ImportOffer = defineTaggedUnion({
  Asking: { count: Schema.Finite },
  Declined: {},
  Moving: { count: Schema.Finite },
  None: {},
});

export type ImportOfferValue = typeof ImportOffer.Type;

export const TrackerState = defineTaggedUnion({
  Local: {},
  Remote: {
    adding: Schema.Array(PendingTrack),
    jobs: Schema.Array(TrackedJob),
    loaded: Schema.Boolean,
    offer: ImportOffer,
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
  billing: BillingModel,
  draftSearch: Schema.String,
  filters: Filters,
  generation: Schema.Finite,
  job: JobState,
  jobs: JobsState,
  listing: ListingState,
  marks: Shortlist,
  more: MoreState,
  origin: Schema.String,
  route: Route,
  savedSearches: SavedSearchesModel,
  stats: StatsState,
  tracker: TrackerState,
  trackerRevision: Schema.Finite,
});

export type ModelValue = typeof Model.Type;
