import { describe, expect, it } from "@effect/vitest";
import {
  Account,
  CurrentViewer,
  importShortlist,
  JobStore,
  noteTrackedJob,
  TRACKER_LIMIT,
  TrackedJobs,
  trackedJobs,
  TrackerFull,
  trackJob,
  TrackRequest,
  Unauthorized,
  untrackJob,
  Viewer,
  MAX_IMPORTED_JOBS,
} from "@rat-stack/core";
import type {
  JobValue,
  StageValue,
  TrackerStore,
  TrackRequestValue,
  ViewerValue,
} from "@rat-stack/core";
import { Array, Effect, Option, pipe, Schema } from "effect";
import { TestClock } from "effect/testing";

import { sqlJsJobStore } from "./sqljs-executor.js";

const memberOf = (id: string) =>
  Viewer.Member({
    account: Schema.decodeSync(Account)({
      email: `${id}@example.com`,
      id,
      name: id,
    }),
  });

const ada = memberOf("user_ada");

const grace = memberOf("user_grace");

const as =
  (viewer: ViewerValue) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, CurrentViewer, viewer);

const request = (jobId: string, stage: StageValue = "Saved") => ({
  jobId,
  snapshot: {
    company: "Acme",
    location: "Remote - Canada",
    title: `Engineering Manager ${jobId}`,
    url: `https://jobs.example/${jobId}`,
  },
  stage,
});

const listing = (id: string): JobValue => ({
  arrangement: "Remote",
  company: "Acme",
  feed: "greenhouse:acme",
  firstSeenAt: 0,
  id,
  lastSeenAt: 0,
  location: "Remote - Canada",
  postedAt: 0,
  region: "RemoteCanada",
  relevance: 50,
  role: "EngineeringManager",
  salary: null,
  source: "Greenhouse",
  title: `Engineering Manager ${id}`,
  url: `https://jobs.example/${id}`,
});

const withStore = <A, E>(body: Effect.Effect<A, E, JobStore | TrackerStore>) =>
  Effect.gen(function* runWithStore() {
    const layer = yield* sqlJsJobStore;

    return yield* body.pipe(Effect.provide(layer));
  });

const encodeTracker = Schema.encodeSync(TrackedJobs);

const jobIdsOf = (tracker: readonly { readonly jobId: string }[]) =>
  pipe(
    tracker,
    Array.map(({ jobId }) => jobId)
  ).toSorted();

const Shortlist = Schema.Array(
  Schema.Struct({
    ...TrackRequest.fields,
    jobId: Schema.Literals(["g:1", "g:2", "g:3", "l:1", "a:1"]),
  })
);

describe("tracker", () => {
  it.effect.prop(
    "importing the same browser shortlist twice tracks each job exactly once",
    { shortlist: Shortlist },
    ({ shortlist }) =>
      withStore(
        Effect.gen(function* importTwice() {
          const jobs: readonly TrackRequestValue[] = shortlist;
          const first = yield* importShortlist.handler({ jobs });

          yield* TestClock.adjust("1 hour");

          const second = yield* importShortlist.handler({ jobs });

          expect(jobIdsOf(second)).toStrictEqual(Array.dedupe(jobIdsOf(jobs)));
          expect(encodeTracker(second)).toStrictEqual(encodeTracker(first));
        }).pipe(as(ada))
      )
  );

  it.effect(
    "an import never overwrites the stage a member already set on the server",
    () =>
      withStore(
        Effect.gen(function* importKeepsServerStage() {
          yield* trackJob.handler(request("g:1", "Interviewing"));

          const tracker = yield* importShortlist.handler({
            jobs: [request("g:1", "Saved"), request("g:2", "Applied")],
          });

          expect(
            pipe(
              tracker,
              Array.map(({ jobId, stage }) => `${jobId} ${stage}`)
            ).toSorted()
          ).toStrictEqual(["g:1 Interviewing", "g:2 Applied"]);
        }).pipe(as(ada))
      )
  );

  it.effect(
    "moving a job keeps its saved date, stamps the move, and persists every stage",
    () =>
      withStore(
        Effect.gen(function* moveThroughStages() {
          yield* trackJob.handler(request("g:1"));

          const moves: readonly StageValue[] = [
            "Applied",
            "Interviewing",
            "Offer",
            "Rejected",
          ];

          for (const [index, stage] of moves.entries()) {
            yield* TestClock.adjust("1 day");

            const [moved] = yield* trackJob.handler(request("g:1", stage));

            expect(moved?.stage).toBe(stage);
            expect(moved?.savedAt).toBe(0);
            expect(moved?.movedAt).toBe((index + 1) * 86_400_000);
          }

          yield* TestClock.adjust("1 day");

          const [unmoved] = yield* trackJob.handler(request("g:1", "Rejected"));

          expect(unmoved?.movedAt).toBe(4 * 86_400_000);
          expect(yield* trackedJobs.handler({})).toHaveLength(1);
        }).pipe(as(ada))
      )
  );

  it.effect("notes persist and removing a job drops it", () =>
    withStore(
      Effect.gen(function* noteThenRemove() {
        yield* trackJob.handler(request("g:1"));
        yield* trackJob.handler(request("g:2"));

        const noted = yield* noteTrackedJob.handler({
          jobId: "g:1",
          notes: "Recruiter call Tuesday",
        });

        expect(
          pipe(
            Array.findFirst(noted, ({ jobId }) => jobId === "g:1"),
            Option.map(({ notes }) => notes)
          )
        ).toStrictEqual(Option.some("Recruiter call Tuesday"));

        const remaining = yield* untrackJob.handler({ jobId: "g:1" });

        expect(jobIdsOf(remaining)).toStrictEqual(["g:2"]);
        expect(jobIdsOf(yield* trackedJobs.handler({}))).toStrictEqual(["g:2"]);
      }).pipe(as(ada))
    )
  );

  it.effect(
    "a tracked job keeps its snapshot and reports it unlisted once the board prunes it",
    () =>
      withStore(
        Effect.gen(function* prunedListing() {
          const store = yield* JobStore;

          yield* store.replaceFeed("greenhouse:acme", [listing("g:1")], 0);

          const [listed] = yield* trackJob.handler(request("g:1"));

          expect(listed?.listed).toBe(true);

          yield* store.prune({ departedBefore: 1, unseenBefore: 1 });

          const [pruned] = yield* trackedJobs.handler({});

          expect(pruned?.listed).toBe(false);
          expect(pruned?.snapshot).toStrictEqual(request("g:1").snapshot);
        }).pipe(as(ada))
      )
  );

  it.effect(
    "a tracked job reads as unlisted as soon as its feed stops listing it",
    () =>
      withStore(
        Effect.gen(function* departedListing() {
          const store = yield* JobStore;

          yield* store.replaceFeed("greenhouse:acme", [listing("g:1")], 0);
          yield* trackJob.handler(request("g:1"));
          yield* store.replaceFeed("greenhouse:acme", [], 10);

          const [departed] = yield* trackedJobs.handler({});

          expect(departed?.listed).toBe(false);
        }).pipe(as(ada))
      )
  );

  it.effect(
    "one member can never read, note, move, or remove another member's tracked jobs",
    () =>
      withStore(
        Effect.gen(function* isolation() {
          yield* trackJob.handler(request("g:1", "Interviewing")).pipe(as(ada));

          const graceSees = yield* Effect.gen(function* graceTries() {
            const before = yield* trackedJobs.handler({});

            yield* noteTrackedJob.handler({ jobId: "g:1", notes: "mine now" });
            yield* untrackJob.handler({ jobId: "g:1" });
            yield* trackJob.handler(request("g:1", "Rejected"));

            return before;
          }).pipe(as(grace));

          const adaSees = yield* trackedJobs.handler({}).pipe(as(ada));

          expect(graceSees).toStrictEqual([]);
          expect(
            pipe(
              adaSees,
              Array.map(({ jobId, notes, stage }) => ({ jobId, notes, stage }))
            )
          ).toStrictEqual([{ jobId: "g:1", notes: "", stage: "Interviewing" }]);
        })
      )
  );

  it.effect(
    "an anonymous viewer is refused every tracker capability and changes nothing",
    () =>
      withStore(
        Effect.gen(function* anonymous() {
          yield* trackJob.handler(request("g:1")).pipe(as(ada));

          const refusals = yield* Effect.forEach(
            [
              trackedJobs.handler({}),
              trackJob.handler(request("g:2")),
              importShortlist.handler({ jobs: [request("g:3")] }),
              noteTrackedJob.handler({ jobId: "g:1", notes: "x" }),
              untrackJob.handler({ jobId: "g:1" }),
            ],
            (call) => Effect.flip(call.pipe(as(Viewer.Anonymous())))
          );

          for (const refusal of refusals) {
            expect(refusal).toBeInstanceOf(Unauthorized);
          }

          expect(
            jobIdsOf(yield* trackedJobs.handler({}).pipe(as(ada)))
          ).toStrictEqual(["g:1"]);
        })
      )
  );

  it.effect(
    "a full tracker refuses new jobs atomically but still moves and frees its own",
    () =>
      withStore(
        Effect.gen(function* fullTracker() {
          const full = new TrackerFull({ limit: TRACKER_LIMIT });

          const filler = Array.makeBy(TRACKER_LIMIT - 1, (index) =>
            request(`f:${index}`)
          );

          yield* Effect.forEach(
            Array.chunksOf(filler, MAX_IMPORTED_JOBS),
            (jobs) => importShortlist.handler({ jobs })
          );

          const overflowingImport = yield* Effect.flip(
            importShortlist.handler({
              jobs: [request("g:1"), request("g:2")],
            })
          );

          expect(overflowingImport).toStrictEqual(full);
          expect(yield* trackedJobs.handler({})).toHaveLength(
            TRACKER_LIMIT - 1
          );

          expect(yield* trackJob.handler(request("g:1"))).toHaveLength(
            TRACKER_LIMIT
          );
          expect(
            yield* Effect.flip(trackJob.handler(request("g:2")))
          ).toStrictEqual(full);

          const moved = yield* trackJob.handler(request("f:0", "Applied"));

          expect(
            Array.findFirst(moved, ({ jobId }) => jobId === "f:0").pipe(
              Option.map(({ stage }) => stage)
            )
          ).toStrictEqual(Option.some("Applied"));

          expect(
            yield* trackJob.handler(request("g:2")).pipe(as(grace))
          ).toHaveLength(1);

          yield* untrackJob.handler({ jobId: "f:1" });

          const freed = yield* trackJob.handler(request("g:2"));

          expect(freed).toHaveLength(TRACKER_LIMIT);
          expect(freed.some(({ jobId }) => jobId === "g:2")).toBe(true);
        }).pipe(as(ada))
      )
  );
});
