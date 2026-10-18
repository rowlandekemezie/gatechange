import {
  BoardStats,
  EpochMillis,
  JobDetail,
  ListedJob,
} from "@rat-stack/core/contracts";
import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { ListingRoute } from "../listing.js";
import { Route } from "../route.js";
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
    jobs: Schema.Array(ListedJob),
    route: ListingRoute,
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
    jobs: Schema.Array(ListedJob),
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

export const Model = Schema.Struct({
  awaitingEcho: Schema.Array(Schema.String),
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
  stats: StatsState,
});

export type ModelValue = typeof Model.Type;
