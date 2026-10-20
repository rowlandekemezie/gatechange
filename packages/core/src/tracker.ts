import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { AccountIdValue } from "./account.js";
import type { JobStoreUnavailable } from "./job-store-unavailable.js";
import { EpochMillis } from "./job.js";
import type { TrackerFull } from "./tracker-full.js";
import type { TrackerJobIdTooLong } from "./tracker-job-id-too-long.js";
import type { TrackerStorageFull } from "./tracker-storage-full.js";

export const stages = [
  "Saved",
  "Applied",
  "Interviewing",
  "Offer",
  "Rejected",
] as const;

export const Stage = Schema.Literals(stages);

export type StageValue = typeof Stage.Type;

export const MAX_NOTES_LENGTH = 2000;

export const MAX_IMPORTED_JOBS = 200;

export const TRACKER_LIMIT = 500;

export const TRACKER_BYTE_LIMIT = 4 * 1024 * 1024;

export const MAX_NEW_TRACKED_JOB_ID_BYTES = 200;

const SnapshotText = Schema.String.check(Schema.isMaxLength(500));

const TrackedJobId = Schema.NonEmptyString.check(Schema.isMaxLength(1000));

export const JobSnapshot = Schema.Struct({
  company: SnapshotText,
  location: SnapshotText,
  title: SnapshotText,
  url: SnapshotText,
});

export type JobSnapshotValue = typeof JobSnapshot.Type;

export const TrackOrMoveRequest = Schema.Struct({
  jobId: TrackedJobId,
  snapshot: JobSnapshot,
  stage: Stage,
});

export type TrackOrMoveRequestValue = typeof TrackOrMoveRequest.Type;

export const TrackRequest = Schema.Struct({
  ...TrackOrMoveRequest.fields,
  jobId: TrackedJobId.check(
    Schema.makeFilter(
      (id) =>
        new TextEncoder().encode(id).byteLength <=
          MAX_NEW_TRACKED_JOB_ID_BYTES ||
        "new tracked job IDs must fit 200 UTF-8 bytes"
    )
  ),
});

export type TrackRequestValue = typeof TrackRequest.Type;

export const Notes = Schema.String.check(Schema.isMaxLength(MAX_NOTES_LENGTH));

export const TrackedJob = Schema.Struct({
  jobId: TrackedJobId,
  listed: Schema.Boolean,
  movedAt: EpochMillis,
  notes: Notes,
  savedAt: EpochMillis,
  snapshot: JobSnapshot,
  stage: Stage,
});

export type TrackedJobValue = typeof TrackedJob.Type;

export const TrackedJobs = Schema.Array(TrackedJob);

export const ImportShortlist = Schema.Struct({
  jobs: Schema.Array(TrackRequest).check(Schema.isMaxLength(MAX_IMPORTED_JOBS)),
});

export class TrackerStore extends Context.Service<
  TrackerStore,
  {
    readonly importMissing: (
      owner: AccountIdValue,
      jobs: readonly TrackRequestValue[],
      now: number
    ) => Effect.Effect<
      void,
      | JobStoreUnavailable
      | TrackerFull
      | TrackerStorageFull
      | TrackerJobIdTooLong
    >;
    readonly list: (
      owner: AccountIdValue
    ) => Effect.Effect<readonly TrackedJobValue[], JobStoreUnavailable>;
    readonly note: (
      owner: AccountIdValue,
      jobId: string,
      notes: string
    ) => Effect.Effect<void, JobStoreUnavailable | TrackerStorageFull>;
    readonly track: (
      owner: AccountIdValue,
      job: TrackOrMoveRequestValue,
      now: number
    ) => Effect.Effect<
      void,
      | JobStoreUnavailable
      | TrackerFull
      | TrackerStorageFull
      | TrackerJobIdTooLong
    >;
    readonly untrack: (
      owner: AccountIdValue,
      jobId: string
    ) => Effect.Effect<void, JobStoreUnavailable>;
  }
>()("@rat-stack/core/TrackerStore") {}
