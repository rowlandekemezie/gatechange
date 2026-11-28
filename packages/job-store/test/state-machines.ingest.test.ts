import { describe, expect, it } from "@effect/vitest";
import {
  DAY_MILLIS,
  FeedUnavailable,
  INGEST_LEASE_MILLIS,
  JobStore,
  PostingFeeds,
  runIngest,
} from "@rat-stack/core";
import type { FeedRef, PostingValue } from "@rat-stack/core";
import { Effect, Exit, Option, Schema } from "effect";
import { TestClock } from "effect/testing";

import { SqlExecutor, statement } from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const BOARD = "greenhouse:acme-cloud";

const plan = { feedConcurrency: 1, feedsPerRun: 1 };

const board: FeedRef = {
  company: Option.some("Acme Cloud"),
  coverage: "Complete",
  key: BOARD,
  minIntervalMinutes: 1,
  source: "Greenhouse",
};

const posting = (externalId: string, title: string): PostingValue => ({
  company: "Acme Cloud",
  externalId,
  location: "Remote - Canada",
  postedAt: null,
  salary: null,
  title,
  url: `https://jobs.example/${externalId}`,
  workplace: "Remote",
});

const vp = posting("vp", "VP Engineering");

const manager = posting("em", "Engineering Manager, Billing");

const JobRow = Schema.Struct({
  departed_at: Schema.NullOr(Schema.Finite),
  id: Schema.String,
});

const CountRow = Schema.Struct({ n: Schema.Finite });

const jobRows = SqlExecutor.use((sql) =>
  sql.all(
    "jobRows",
    statement("SELECT id, departed_at FROM jobs ORDER BY id"),
    JobRow
  )
);

const receipts = SqlExecutor.use((sql) =>
  sql.all(
    "receipts",
    statement("SELECT COUNT(*) AS n FROM ingest_runs"),
    CountRow
  )
).pipe(Effect.map((rows) => rows[0]?.n ?? 0));

const feedsListing = (
  fetch: (
    feed: FeedRef
  ) => Effect.Effect<readonly PostingValue[], FeedUnavailable>
) => PostingFeeds.of({ catalog: [board], fetch });

const ingestAt = (
  at: number,
  fetch: (
    feed: FeedRef
  ) => Effect.Effect<readonly PostingValue[], FeedUnavailable>
) =>
  TestClock.setTime(at).pipe(
    Effect.andThen(runIngest(plan)),
    Effect.provideService(PostingFeeds, feedsListing(fetch))
  );

const listing = (postings: readonly PostingValue[]) => () =>
  Effect.succeed(postings);

const failing = () =>
  Effect.fail(new FeedUnavailable({ feed: BOARD, message: "board is down" }));

const withStore = <A, E>(body: Effect.Effect<A, E, JobStore | SqlExecutor>) =>
  Effect.gen(function* provideStore() {
    const base = yield* sqlJsJobStore;

    return yield* body.pipe(Effect.provide(base));
  });

describe("server-ingest-lease model replay", () => {
  it.effect(
    "RunsNeverOverlap and RejectedRunWritesNothing: a run that fires during a held lease is refused and writes nothing",
    () =>
      withStore(
        Effect.gen(function* overlapping() {
          let overlap: Exit.Exit<unknown, unknown> | undefined;
          const store = yield* JobStore;

          const fetchWithOverlap = () =>
            Effect.gen(function* secondCron() {
              if (overlap === undefined) {
                yield* TestClock.adjust(60_000);
                overlap = yield* runIngest(plan).pipe(
                  Effect.provideService(
                    PostingFeeds,
                    feedsListing(listing([manager]))
                  ),
                  Effect.provideService(JobStore, store),
                  Effect.exit
                );
              }

              return [vp];
            });

          yield* ingestAt(NOW, fetchWithOverlap);

          expect(
            overlap !== undefined &&
              Exit.isFailure(overlap) &&
              JSON.stringify(overlap).includes("IngestInProgress")
          ).toBe(true);
          expect(yield* receipts).toBe(1);
          expect((yield* jobRows).map((row) => row.id)).toEqual([
            `${BOARD}:vp`,
          ]);
        })
      )
  );

  it.effect(
    "FinishedRunFreesLease: the next cron after a finished run takes the lease",
    () =>
      withStore(
        Effect.gen(function* sequential() {
          yield* ingestAt(NOW, listing([vp]));
          yield* ingestAt(NOW + 20 * 60_000, listing([vp]));

          expect(yield* receipts).toBe(2);
        })
      )
  );

  it.effect(
    "RunsNeverOverlap: a run killed before it frees the lease blocks the next cron only until the lease ends",
    () =>
      withStore(
        Effect.gen(function* killed() {
          const store = yield* JobStore;

          yield* ingestAt(NOW, listing([vp])).pipe(
            Effect.provideService(JobStore, {
              ...store,
              releaseIngest: () => Effect.void,
            })
          );

          const early = yield* ingestAt(
            NOW + INGEST_LEASE_MILLIS - 1,
            listing([vp])
          ).pipe(Effect.exit);

          const late = yield* ingestAt(
            NOW + INGEST_LEASE_MILLIS,
            listing([vp])
          );

          expect(Exit.isFailure(early)).toBe(true);
          expect(late.receipt.outcome).toBe("Succeeded");
          expect(yield* receipts).toBe(2);
        })
      )
  );
});

describe("server-feed-replacement model replay", () => {
  it.effect(
    "ListedRoleIsOpen and UnlistedRoleDeparts: a successful fetch keeps what it lists and departs the rest",
    () =>
      withStore(
        Effect.gen(function* replaced() {
          yield* ingestAt(NOW, listing([vp, manager]));
          yield* ingestAt(NOW + 20 * 60_000, listing([vp]));

          expect(yield* jobRows).toEqual([
            { departed_at: NOW + 20 * 60_000, id: `${BOARD}:em` },
            { departed_at: null, id: `${BOARD}:vp` },
          ]);
        })
      )
  );

  it.effect(
    "FailedFetchChangesNothing: a failed fetch leaves every role as it was",
    () =>
      withStore(
        Effect.gen(function* failed() {
          yield* ingestAt(NOW, listing([vp, manager]));
          const before = yield* jobRows;

          yield* ingestAt(NOW + 20 * 60_000, failing);

          expect(yield* jobRows).toEqual(before);
          expect(yield* receipts).toBe(2);
        })
      )
  );

  it.effect(
    "ListedRoleIsOpen: a role listed again after it departed reopens",
    () =>
      withStore(
        Effect.gen(function* reopened() {
          yield* ingestAt(NOW, listing([vp, manager]));
          yield* ingestAt(NOW + 20 * 60_000, listing([vp]));
          yield* ingestAt(NOW + 40 * 60_000, listing([vp, manager]));

          expect((yield* jobRows).map((row) => row.departed_at)).toEqual([
            null,
            null,
          ]);
        })
      )
  );

  it.effect(
    "DepartedRolePruned: a role departed more than a day ago is pruned",
    () =>
      withStore(
        Effect.gen(function* pruned() {
          yield* ingestAt(NOW, listing([vp, manager]));
          yield* ingestAt(NOW + 20 * 60_000, listing([vp]));
          yield* ingestAt(NOW + 2 * DAY_MILLIS, listing([vp]));

          expect((yield* jobRows).map((row) => row.id)).toEqual([
            `${BOARD}:vp`,
          ]);
        })
      )
  );
});
