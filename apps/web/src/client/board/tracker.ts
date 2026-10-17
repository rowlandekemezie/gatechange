import type { StageValue, TrackRequestValue } from "@rat-stack/core/contracts";
import { Array, Option, pipe } from "effect";

import { TrackerChange, TrackerState } from "./model.js";
import type {
  MarkedJobValue,
  RemoteTrackerValue,
  TrackerChangeValue,
} from "./model.js";

const SNAPSHOT_LIMIT = 500;

const clipped = (text: string) => text.slice(0, SNAPSHOT_LIMIT);

interface Trackable {
  readonly company: string;
  readonly id: string;
  readonly location: string;
  readonly title: string;
  readonly url: string;
}

export const trackRequestOf = (
  job: Trackable,
  stage: StageValue
): TrackRequestValue => ({
  jobId: job.id,
  snapshot: {
    company: clipped(job.company),
    location: clipped(job.location),
    title: clipped(job.title),
    url: clipped(job.url),
  },
  stage,
});

export const importRequestsOf = (
  marks: readonly MarkedJobValue[]
): readonly TrackRequestValue[] =>
  pipe(
    marks,
    Array.filter((mark) => mark.id !== ""),
    Array.map((mark) => trackRequestOf(mark, mark.kind))
  );

export const unloadedTracker = TrackerState.Remote({
  adding: [],
  jobs: [],
  loaded: false,
  problem: Option.none(),
});

const withoutJob = (
  tracker: RemoteTrackerValue,
  jobId: string
): RemoteTrackerValue =>
  TrackerState.Remote({
    ...tracker,
    adding: pipe(
      tracker.adding,
      Array.filter((pending) => pending.jobId !== jobId)
    ),
    jobs: pipe(
      tracker.jobs,
      Array.filter((tracked) => tracked.jobId !== jobId)
    ),
  });

const tracked = (
  tracker: RemoteTrackerValue,
  jobId: string,
  stage: StageValue
): RemoteTrackerValue => {
  const isTracked = pipe(
    tracker.jobs,
    Array.some((job) => job.jobId === jobId)
  );

  if (!isTracked) {
    const rest = withoutJob(tracker, jobId);

    return TrackerState.Remote({
      ...rest,
      adding: [...rest.adding, { jobId, stage }],
    });
  }

  return TrackerState.Remote({
    ...tracker,
    jobs: pipe(
      tracker.jobs,
      Array.map((job) => (job.jobId === jobId ? { ...job, stage } : job))
    ),
  });
};

export const changedTracker = (
  tracker: RemoteTrackerValue,
  change: TrackerChangeValue
): RemoteTrackerValue =>
  TrackerChange.match<RemoteTrackerValue>(change, {
    Note: ({ jobId, notes }) =>
      TrackerState.Remote({
        ...tracker,
        jobs: pipe(
          tracker.jobs,
          Array.map((job) => (job.jobId === jobId ? { ...job, notes } : job))
        ),
      }),
    Track: ({ job: { jobId, stage } }) => tracked(tracker, jobId, stage),
    Untrack: ({ jobId }) => withoutJob(tracker, jobId),
  });
