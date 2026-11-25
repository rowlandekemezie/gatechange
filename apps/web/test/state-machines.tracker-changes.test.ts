import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { stageOf } from "../src/client/board/marks.js";
import { Message } from "../src/client/board/message.js";
import {
  named,
  oldJob,
  sentAll,
  signedIn,
  started,
  trackedOf,
  walked,
} from "./state-machines.support.js";

const loaded = () => {
  const ready = sentAll(started("/shortlist"), [signedIn]);

  return sentAll(ready, [
    Message.CompletedSyncTracker({
      jobs: [trackedOf(oldJob, "Saved")],
      revision: ready.model.trackerRevision,
      waiting: 0,
    }),
  ]);
};

describe("TrackerChanges model replay", () => {
  it.fails("SettledCardMatchesServer and FailureIsAnnounced: two quick moves answered out of order end on the stage the server kept", () => {
    const ready = loaded();

    const applied = sentAll(ready, [
      Message.ChangedStage({ jobId: oldJob.id, stage: "Applied" }),
    ]);

    const appliedRevision = applied.model.trackerRevision;

    const interviewing = sentAll(applied, [
      Message.ChangedStage({ jobId: oldJob.id, stage: "Interviewing" }),
    ]);

    const interviewingRevision = interviewing.model.trackerRevision;

    const path = walked(interviewing, [
      Message.SucceededTrackerChange({
        jobs: [trackedOf(oldJob, "Interviewing")],
        revision: interviewingRevision,
      }),
      Message.SucceededTrackerChange({
        jobs: [trackedOf(oldJob, "Applied")],
        revision: appliedRevision,
      }),
    ]);

    const shown = stageOf(path.last.model, oldJob.id);
    const reloads = named(path.last.commands, "SyncTracker").length > 0;

    expect(reloads || Option.contains(shown, "Applied")).toBe(true);
  });

  it("holds: replies in order settle on the last stage the server saved", () => {
    const ready = loaded();

    const applied = sentAll(ready, [
      Message.ChangedStage({ jobId: oldJob.id, stage: "Applied" }),
    ]);

    const appliedRevision = applied.model.trackerRevision;

    const interviewing = sentAll(applied, [
      Message.ChangedStage({ jobId: oldJob.id, stage: "Interviewing" }),
    ]);

    const settled = sentAll(interviewing, [
      Message.SucceededTrackerChange({
        jobs: [trackedOf(oldJob, "Applied")],
        revision: appliedRevision,
      }),
      Message.SucceededTrackerChange({
        jobs: [trackedOf(oldJob, "Interviewing")],
        revision: interviewing.model.trackerRevision,
      }),
    ]);

    expect(stageOf(settled.model, oldJob.id)).toStrictEqual(
      Option.some("Interviewing")
    );
  });

  it("holds: a failed current move shows the banner and reloads the tracker", () => {
    const moved = sentAll(loaded(), [
      Message.ChangedStage({ jobId: oldJob.id, stage: "Applied" }),
    ]);

    const failed = sentAll(moved, [
      Message.FailedTrackerChange({
        message: "Your tracker is unavailable right now.",
        revision: moved.model.trackerRevision,
      }),
    ]);

    expect(named(failed.commands, "SyncTracker")).toHaveLength(1);
    expect(failed.model.tracker).toMatchObject({
      problem: Option.some("Your tracker is unavailable right now."),
    });
  });
});
