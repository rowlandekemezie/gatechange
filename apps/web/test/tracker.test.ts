import { describe, expect, it } from "@effect/vitest";
import { Account } from "@rat-stack/core/contracts";
import type { JobValue, TrackedJobValue } from "@rat-stack/core/contracts";
import { Array, Option, pipe, Schema } from "effect";
import { fromString } from "foldkit/url";

import { Message as AccountMessage } from "../src/client/account/message.js";
import { shortlistSize, stageOf } from "../src/client/board/marks.js";
import { Message } from "../src/client/board/message.js";
import type { MessageValue } from "../src/client/board/message.js";
import type { ModelValue } from "../src/client/board/model.js";
import { init, update } from "../src/client/board/update.js";

interface Step {
  readonly commands: readonly {
    readonly name: string;
    readonly args?: unknown;
  }[];
  readonly model: ModelValue;
}

const started = (): Step => {
  const { commands = [], model } = init(
    Option.getOrThrow(fromString("https://jobs.example/shortlist"))
  );

  return { commands, model };
};

const sentAll = (step: Step, messages: readonly MessageValue[]): Step => {
  let current = step;

  for (const message of messages) {
    const { commands = [], model } = update(current.model, message);
    current = { commands, model };
  }

  return current;
};

const named = (step: Step, name: string) =>
  pipe(
    step.commands,
    Array.filter((command) => command.name === name)
  );

const ada = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

const signedIn = Message.GotAccountMessage({
  message: AccountMessage.CompletedFetchSession({ account: Option.some(ada) }),
});

const signedOut = Message.GotAccountMessage({
  message: AccountMessage.CompletedFetchSession({ account: Option.none() }),
});

const job: JobValue = {
  arrangement: "Remote",
  company: "Moniepoint",
  feed: "himalayas:engineering-manager",
  firstSeenAt: 1_760_000_000_000,
  id: "himalayas:moniepoint-em",
  lastSeenAt: 1_760_000_000_000,
  location: "Remote, Canada",
  postedAt: 1_760_000_000_000,
  region: "RemoteCanada",
  relevance: 12,
  role: "EngineeringManager",
  salary: null,
  source: "Himalayas",
  title: "Engineering Manager",
  url: "https://himalayas.app/jobs/moniepoint-em",
};

const trackedAs = (stage: TrackedJobValue["stage"]): TrackedJobValue => ({
  jobId: job.id,
  listed: true,
  movedAt: 1_760_000_000_000,
  notes: "",
  savedAt: 1_760_000_000_000,
  snapshot: {
    company: job.company,
    location: job.location,
    title: job.title,
    url: job.url,
  },
  stage,
});

const revisionOf = (step: Step) => step.model.trackerRevision;

describe("tracker sync", () => {
  it("a signed-out viewer keeps the browser shortlist and never calls the tracker", () => {
    const step = sentAll(started(), [
      signedOut,
      Message.ClickedMark({ job, kind: "Applied" }),
    ]);

    expect(named(step, "WriteShortlist")).toHaveLength(1);
    expect(named(step, "SendTrackerChange")).toHaveLength(0);
    expect(step.model.tracker._tag).toBe("Local");
    expect(stageOf(step.model, job.id)).toStrictEqual(Option.some("Applied"));
  });

  it("signing in starts exactly one sync, and later account messages do not repeat it", () => {
    const first = sentAll(started(), [signedIn]);

    expect(named(first, "SyncTracker")).toHaveLength(1);

    const again = sentAll(first, [
      signedIn,
      Message.GotAccountMessage({
        message: AccountMessage.CompletedFetchSignInOptions({
          socialProviders: [],
        }),
      }),
    ]);

    expect(named(again, "SyncTracker")).toHaveLength(0);
  });

  it("a completed sync shows the server tracker and drops the local list", () => {
    const local = sentAll(started(), [
      Message.CompletedReadShortlist({
        marks: [
          {
            company: job.company,
            id: job.id,
            kind: "Saved",
            location: job.location,
            title: job.title,
            url: job.url,
          },
        ],
      }),
      signedIn,
    ]);

    const synced = sentAll(local, [
      Message.CompletedSyncTracker({
        jobs: [trackedAs("Interviewing")],
        revision: revisionOf(local),
      }),
    ]);

    expect(synced.model.marks).toStrictEqual([]);
    expect(stageOf(synced.model, job.id)).toStrictEqual(
      Option.some("Interviewing")
    );
  });

  it("a click shows the new stage at once and ignores a reply from an earlier change", () => {
    const ready = sentAll(started(), [signedIn]);

    const loaded = sentAll(ready, [
      Message.CompletedSyncTracker({ jobs: [], revision: revisionOf(ready) }),
      Message.ClickedMark({ job, kind: "Saved" }),
    ]);

    expect(named(loaded, "SendTrackerChange")).toHaveLength(1);
    expect(stageOf(loaded.model, job.id)).toStrictEqual(Option.some("Saved"));
    expect(shortlistSize(loaded.model)).toBe(1);

    const savedRevision = revisionOf(loaded);

    const moved = sentAll(loaded, [
      Message.ClickedMark({ job, kind: "Applied" }),
    ]);

    const late = sentAll(moved, [
      Message.SucceededTrackerChange({
        jobs: [trackedAs("Saved")],
        revision: savedRevision,
      }),
    ]);

    expect(stageOf(late.model, job.id)).toStrictEqual(Option.some("Applied"));

    const settled = sentAll(late, [
      Message.SucceededTrackerChange({
        jobs: [trackedAs("Applied")],
        revision: revisionOf(late),
      }),
    ]);

    expect(stageOf(settled.model, job.id)).toStrictEqual(
      Option.some("Applied")
    );
    expect(shortlistSize(settled.model)).toBe(1);
  });

  it("a failed change reports the problem and reloads the server tracker", () => {
    const ready = sentAll(started(), [signedIn]);

    const changed = sentAll(ready, [
      Message.CompletedSyncTracker({
        jobs: [trackedAs("Saved")],
        revision: revisionOf(ready),
      }),
      Message.ChangedStage({ jobId: job.id, stage: "Offer" }),
    ]);

    const failed = sentAll(changed, [
      Message.FailedTrackerChange({
        message: "Your tracker is unavailable right now.",
        revision: revisionOf(changed),
      }),
    ]);

    expect(named(failed, "SyncTracker")).toHaveLength(1);
    expect(failed.model.tracker).toMatchObject({
      problem: Option.some("Your tracker is unavailable right now."),
    });
  });

  it("signing out returns to the browser shortlist", () => {
    const ready = sentAll(started(), [signedIn]);

    const out = sentAll(ready, [
      Message.CompletedSyncTracker({
        jobs: [trackedAs("Offer")],
        revision: revisionOf(ready),
      }),
      signedOut,
    ]);

    expect(out.model.tracker._tag).toBe("Local");
    expect(named(out, "ReadShortlist")).toHaveLength(1);
    expect(stageOf(out.model, job.id)).toStrictEqual(Option.none());
  });
});
