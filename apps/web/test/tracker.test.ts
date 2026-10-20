import { afterEach, describe, expect, it } from "@effect/vitest";
import { Account, TrackerFull } from "@rat-stack/core/contracts";
import type { JobValue, TrackedJobValue } from "@rat-stack/core/contracts";
import { Array, Effect, Option, pipe, Schema } from "effect";
import { fromString } from "foldkit/url";
import { vi } from "vitest";

import { Message as AccountMessage } from "../src/client/account/message.js";
import {
  ImportStoredShortlist,
  SendTrackerChange,
  SyncTracker,
} from "../src/client/board/command.js";
import { shortlistSize, stageOf } from "../src/client/board/marks.js";
import { Message } from "../src/client/board/message.js";
import type { MessageValue } from "../src/client/board/message.js";
import {
  ImportOffer,
  Preload,
  TrackerChange,
  TrackerState,
} from "../src/client/board/model.js";
import type { ModelValue } from "../src/client/board/model.js";
import { JobQueries } from "../src/client/board/queries.js";
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
    { origin: "https://jobs.example", preload: Preload.Nothing() },
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
        waiting: 0,
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
      Message.CompletedSyncTracker({
        jobs: [],
        revision: revisionOf(ready),
        waiting: 0,
      }),
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
        waiting: 0,
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
        waiting: 0,
      }),
      signedOut,
    ]);

    expect(out.model.tracker._tag).toBe("Local");
    expect(named(out, "ReadShortlist")).toHaveLength(1);
    expect(stageOf(out.model, job.id)).toStrictEqual(Option.none());
  });
});

const SHORTLIST_KEY = "jobs.shortlist.v1";

const storedMarks = JSON.stringify([
  {
    company: job.company,
    id: job.id,
    kind: "Applied",
    location: job.location,
    title: job.title,
    url: job.url,
  },
]);

const browserWith = (stored: string | null) => {
  const storage = new Map<string, string>();

  if (stored !== null) {
    storage.set(SHORTLIST_KEY, stored);
  }

  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });

  return storage;
};

const serverWith = (imports: unknown[]) =>
  JobQueries.of({
    companyIntel: () => Effect.die("unused"),
    deleteSearch: () => Effect.die("unused"),
    getJob: () => Effect.die("unused"),
    importShortlist: (jobs) => {
      imports.push(jobs);

      return Effect.succeed([trackedAs("Applied")]);
    },
    listJobs: () => Effect.die("unused"),
    membership: Effect.die("unused"),
    noteTrackedJob: () => Effect.die("unused"),
    openBillingPortal: Effect.die("unused"),
    saveSearch: () => Effect.die("unused"),
    savedSearches: Effect.die("unused"),
    setInstantAlerts: () => Effect.die("unused"),
    signInOptions: Effect.die("unused"),
    startCheckout: () => Effect.die("unused"),
    stats: Effect.die("unused"),
    trackJob: () => Effect.die("unused"),
    trackedJobs: Effect.succeed([]),
    untrackJob: () => Effect.die("unused"),
  });

const withLocalList = () => {
  const ready = sentAll(started(), [signedIn]);

  return sentAll(ready, [
    Message.CompletedSyncTracker({
      jobs: [],
      revision: revisionOf(ready),
      waiting: 3,
    }),
  ]);
};

const offerOf = (step: Step) =>
  Schema.is(TrackerState.Remote)(step.model.tracker)
    ? Option.some(step.model.tracker.offer)
    : Option.none();

describe("first sign-in import", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect(
    "a sign-in sync never moves or clears the browser shortlist on its own",
    () =>
      Effect.gen(function* silentSync() {
        const storage = browserWith(storedMarks);
        const imports: unknown[] = [];

        const reply = yield* SyncTracker({ revision: 1 }).effect.pipe(
          Effect.provideService(JobQueries, serverWith(imports))
        );

        expect(imports).toStrictEqual([]);
        expect(storage.get(SHORTLIST_KEY)).toBe(storedMarks);
        expect(reply).toStrictEqual(
          Message.CompletedSyncTracker({ jobs: [], revision: 1, waiting: 1 })
        );
      })
  );

  it.effect(
    "confirming the move imports the browser shortlist once and clears it",
    () =>
      Effect.gen(function* confirmedImport() {
        const storage = browserWith(storedMarks);
        const imports: unknown[] = [];

        const reply = yield* ImportStoredShortlist({ revision: 2 }).effect.pipe(
          Effect.provideService(JobQueries, serverWith(imports))
        );

        expect(imports).toHaveLength(1);
        expect(storage.has(SHORTLIST_KEY)).toBe(false);
        expect(reply).toStrictEqual(
          Message.CompletedSyncTracker({
            jobs: [trackedAs("Applied")],
            revision: 2,
            waiting: 0,
          })
        );
      })
  );

  it("signing in with a browser shortlist asks first and imports nothing", () => {
    const asked = withLocalList();

    expect(named(asked, "ImportStoredShortlist")).toHaveLength(0);
    expect(offerOf(asked)).toStrictEqual(
      Option.some(ImportOffer.Asking({ count: 3 }))
    );
  });

  it("confirming starts exactly one import and settles once it lands", () => {
    const asked = withLocalList();
    const moving = sentAll(asked, [Message.ClickedMoveShortlist()]);

    expect(named(moving, "ImportStoredShortlist")).toHaveLength(1);
    expect(offerOf(moving)).toStrictEqual(
      Option.some(ImportOffer.Moving({ count: 3 }))
    );

    const twice = sentAll(moving, [Message.ClickedMoveShortlist()]);

    expect(named(twice, "ImportStoredShortlist")).toHaveLength(0);

    const landed = sentAll(moving, [
      Message.CompletedSyncTracker({
        jobs: [trackedAs("Applied")],
        revision: revisionOf(moving),
        waiting: 0,
      }),
    ]);

    expect(offerOf(landed)).toStrictEqual(Option.some(ImportOffer.None()));
    expect(stageOf(landed.model, job.id)).toStrictEqual(Option.some("Applied"));
  });

  it("a failed import asks again and keeps the browser list", () => {
    const moving = sentAll(withLocalList(), [Message.ClickedMoveShortlist()]);

    const failed = sentAll(moving, [
      Message.FailedSyncTracker({
        message: "Your tracker holds 500 jobs.",
        revision: revisionOf(moving),
      }),
    ]);

    expect(offerOf(failed)).toStrictEqual(
      Option.some(ImportOffer.Asking({ count: 3 }))
    );
    expect(failed.model.tracker).toMatchObject({
      problem: Option.some("Your tracker holds 500 jobs."),
    });
  });

  it("declining keeps the browser list and does not ask again on a later sync", () => {
    const declined = sentAll(withLocalList(), [Message.ClickedKeepShortlist()]);

    expect(declined.commands).toStrictEqual([]);
    expect(offerOf(declined)).toStrictEqual(
      Option.some(ImportOffer.Declined())
    );

    const resynced = sentAll(declined, [
      Message.ClickedRetryTracker(),
      Message.CompletedSyncTracker({
        jobs: [],
        revision: revisionOf(declined) + 1,
        waiting: 3,
      }),
    ]);

    expect(offerOf(resynced)).toStrictEqual(
      Option.some(ImportOffer.Declined())
    );
  });
});

describe("tracker cap", () => {
  it.effect("a refused add at the cap tells the member how to make room", () =>
    Effect.gen(function* fullTracker() {
      const reply = yield* SendTrackerChange({
        change: TrackerChange.Track({
          job: {
            jobId: job.id,
            snapshot: trackedAs("Saved").snapshot,
            stage: "Saved",
          },
        }),
        revision: 4,
      }).effect.pipe(
        Effect.provideService(
          JobQueries,
          JobQueries.of({
            ...serverWith([]),
            trackJob: () => Effect.fail(new TrackerFull({ limit: 500 })),
          })
        )
      );

      expect(reply).toStrictEqual(
        Message.FailedTrackerChange({
          message:
            "Your tracker holds 500 jobs, the most it can. Remove a job you no longer need, then add this one.",
          revision: 4,
        })
      );
    })
  );
});
