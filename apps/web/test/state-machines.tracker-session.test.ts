import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { Message } from "../src/client/board/message.js";
import { ImportOffer, TrackerState } from "../src/client/board/model.js";
import {
  lastWrittenShortlist,
  markOf,
  newJob,
  oldJob,
  sentAll,
  signOut,
  signedIn,
  started,
  trackedOf,
  walked,
} from "./state-machines.support.js";

const browserList = [markOf(oldJob)];

const offered = () => {
  const ready = sentAll(started("/shortlist"), [
    Message.CompletedReadShortlist({ marks: browserList }),
    signedIn,
  ]);

  return sentAll(ready, [
    Message.CompletedSyncTracker({
      jobs: [],
      revision: ready.model.trackerRevision,
      waiting: 1,
    }),
  ]);
};

const lateSyncAfterSignOut = () => {
  const ready = sentAll(started("/shortlist"), [
    Message.CompletedReadShortlist({ marks: browserList }),
    signedIn,
  ]);

  const syncRevision = ready.model.trackerRevision;

  return sentAll(ready, [
    ...signOut,
    Message.CompletedReadShortlist({ marks: browserList }),
    Message.CompletedSyncTracker({
      jobs: [],
      revision: syncRevision,
      waiting: 1,
    }),
  ]);
};

describe("TrackerSession model replay", () => {
  it.fails("MovingOnlyWhileMoving: saving a job during the move does not leave Moving stuck", () => {
    const moving = sentAll(offered(), [Message.ClickedMoveShortlist()]);
    const importRevision = moving.model.trackerRevision;

    const tracked = sentAll(moving, [
      Message.ClickedMark({ job: newJob, kind: "Saved" }),
    ]);

    const done = sentAll(tracked, [
      Message.CompletedSyncTracker({
        jobs: [trackedOf(oldJob, "Saved")],
        revision: importRevision,
        waiting: 0,
      }),
      Message.SucceededTrackerChange({
        jobs: [trackedOf(oldJob, "Saved"), trackedOf(newJob, "Saved")],
        revision: tracked.model.trackerRevision,
      }),
    ]);

    expect(done.model.tracker).not.toMatchObject({
      offer: ImportOffer.Moving({ count: 1 }),
    });
  });

  it.fails("BrowserListShown: a tracker list arriving after sign-out keeps the browser shortlist on screen", () => {
    const late = lateSyncAfterSignOut();

    expect(Schema.is(TrackerState.Local)(late.model.tracker)).toBe(true);
    expect(late.model.marks).toStrictEqual(browserList);
  });

  it.fails("NoBrowserJobLost: saving in the browser after that late reply keeps the earlier browser job", () => {
    const path = walked(lateSyncAfterSignOut(), [
      Message.ClickedMark({ job: newJob, kind: "Saved" }),
    ]);

    const marks = lastWrittenShortlist(path.all);

    expect(marks.map((mark) => mark.id)).toContain(oldJob.id);
  });

  it("holds TrackerSettles: a save sent before the first sync answers still ends Loading", () => {
    const ready = sentAll(started("/shortlist"), [signedIn]);
    const syncRevision = ready.model.trackerRevision;

    const tracked = sentAll(ready, [
      Message.ClickedMark({ job: newJob, kind: "Saved" }),
    ]);

    const settled = sentAll(tracked, [
      Message.CompletedSyncTracker({
        jobs: [],
        revision: syncRevision,
        waiting: 0,
      }),
      Message.SucceededTrackerChange({
        jobs: [trackedOf(newJob, "Saved")],
        revision: tracked.model.trackerRevision,
      }),
    ]);

    expect(settled.model.tracker).toMatchObject({ loaded: true });
  });

  it("holds MovingOnlyWhileMoving on the plain path: the move finishing clears Moving", () => {
    const moving = sentAll(offered(), [Message.ClickedMoveShortlist()]);

    const done = sentAll(moving, [
      Message.CompletedSyncTracker({
        jobs: [trackedOf(oldJob, "Saved")],
        revision: moving.model.trackerRevision,
        waiting: 0,
      }),
    ]);

    expect(done.model.tracker).toMatchObject({ offer: ImportOffer.None() });
  });

  it("holds MovingOnlyWhileMoving on a failed move: the offer comes back", () => {
    const moving = sentAll(offered(), [Message.ClickedMoveShortlist()]);

    const failed = sentAll(moving, [
      Message.FailedSyncTracker({
        message: "Could not reach your tracker.",
        revision: moving.model.trackerRevision,
      }),
    ]);

    expect(failed.model.tracker).toMatchObject({
      offer: ImportOffer.Asking({ count: 1 }),
    });
  });
});
