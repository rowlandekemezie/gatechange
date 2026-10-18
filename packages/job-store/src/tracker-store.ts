import {
  Stage,
  TRACKER_LIMIT,
  TrackerFull,
  TrackerStore,
} from "@rat-stack/core";
import type {
  AccountIdValue,
  JobStoreUnavailable,
  TrackRequestValue,
} from "@rat-stack/core";
import { Array, Effect, Layer, pipe, Schema } from "effect";

import { SqlExecutor, statement } from "./sql-executor.js";

const TrackedJobRow = Schema.Struct({
  company: Schema.String,
  job_id: Schema.String,
  listed: Schema.Finite,
  location: Schema.String,
  moved_at: Schema.Finite,
  notes: Schema.String,
  saved_at: Schema.Finite,
  stage: Stage,
  title: Schema.String,
  url: Schema.String,
});

const insertTracked = (
  owner: AccountIdValue,
  { jobId, snapshot, stage }: TrackRequestValue,
  now: number,
  onConflict: string
) =>
  statement(
    `INSERT INTO tracked_jobs
       (account_id, job_id, stage, title, company, location, url, saved_at, moved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, job_id) DO ${onConflict}`,
    [
      owner,
      jobId,
      stage,
      snapshot.title,
      snapshot.company,
      snapshot.location,
      snapshot.url,
      now,
      now,
    ]
  );

const MOVE_TRACKED = `UPDATE SET
  moved_at = CASE WHEN tracked_jobs.stage = excluded.stage
    THEN tracked_jobs.moved_at ELSE excluded.moved_at END,
  stage = excluded.stage,
  title = excluded.title,
  company = excluded.company,
  location = excluded.location,
  url = excluded.url`;

const TRACKER_FULL_SIGNAL = "tracker_full";

const refusedWhenFull = <A>(write: Effect.Effect<A, JobStoreUnavailable>) =>
  write.pipe(
    Effect.catchIf(
      (failure) => failure.message.includes(TRACKER_FULL_SIGNAL),
      () => Effect.fail(new TrackerFull({ limit: TRACKER_LIMIT }))
    )
  );

export const makeTrackerStore = Effect.gen(function* makeTrackerStore() {
  const sql = yield* SqlExecutor;

  return TrackerStore.of({
    importMissing: (owner, jobs, now) =>
      sql
        .batch(
          "import a shortlist",
          pipe(
            jobs,
            Array.map((job) => insertTracked(owner, job, now, "NOTHING"))
          )
        )
        .pipe(refusedWhenFull, Effect.asVoid),
    list: (owner) =>
      sql
        .all(
          "list tracked jobs",
          statement(
            `SELECT t.job_id, t.stage, t.notes, t.title, t.company, t.location,
                    t.url, t.saved_at, t.moved_at,
                    EXISTS (SELECT 1 FROM jobs WHERE jobs.id = t.job_id) AS listed
               FROM tracked_jobs t
              WHERE t.account_id = ?
              ORDER BY t.moved_at DESC, t.job_id`,
            [owner]
          ),
          TrackedJobRow
        )
        .pipe(
          Effect.map(
            Array.map((row) => ({
              jobId: row.job_id,
              listed: row.listed === 1,
              movedAt: row.moved_at,
              notes: row.notes,
              savedAt: row.saved_at,
              snapshot: {
                company: row.company,
                location: row.location,
                title: row.title,
                url: row.url,
              },
              stage: row.stage,
            }))
          )
        ),
    note: (owner, jobId, notes) =>
      sql
        .batch("note a tracked job", [
          statement(
            "UPDATE tracked_jobs SET notes = ? WHERE account_id = ? AND job_id = ?",
            [notes, owner, jobId]
          ),
        ])
        .pipe(Effect.asVoid),
    track: (owner, job, now) =>
      sql
        .batch("track a job", [insertTracked(owner, job, now, MOVE_TRACKED)])
        .pipe(refusedWhenFull, Effect.asVoid),
    untrack: (owner, jobId) =>
      sql
        .batch("untrack a job", [
          statement(
            "DELETE FROM tracked_jobs WHERE account_id = ? AND job_id = ?",
            [owner, jobId]
          ),
        ])
        .pipe(Effect.asVoid),
  });
});

export const trackerStoreLayer = Layer.effect(TrackerStore, makeTrackerStore);
