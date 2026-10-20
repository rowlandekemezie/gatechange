import { expect, it } from "@effect/vitest";
import {
  Account,
  CurrentViewer,
  noteTrackedJob,
  TRACKER_BYTE_LIMIT,
  trackedJobs,
  TrackerStorageFull,
  TrackerStore,
  TrackedJobs,
  TrackerJobIdTooLong,
  TrackRequest,
  trackJob,
  untrackJob,
  Viewer,
} from "@rat-stack/core";
import { Array, Effect, Result, Schema } from "effect";

import { SqlExecutor, statement } from "../src/index.js";
import { seededSqlJsJobStore, sqlJsJobStore } from "./sqljs-executor.js";

const account = Schema.decodeSync(Account)({
  email: "storage@example.com",
  id: "storage",
  name: "Storage",
});

const viewer = Viewer.Member({ account });

const snapshot = {
  company: "Acme",
  location: "Remote, Canada",
  title: "Engineering Manager",
  url: "https://jobs.example/1",
};

const request = (jobId: string) => ({
  jobId,
  snapshot,
  stage: "Saved" as const,
});

const bytes =
  "length(CAST(job_id AS BLOB)) + length(CAST(notes AS BLOB)) + length(CAST(title AS BLOB)) + length(CAST(company AS BLOB)) + length(CAST(location AS BLOB)) + length(CAST(url AS BLOB))";

const cjk = (length: number) => `replace(hex(zeroblob(${length})), '00', '界')`;

it.effect(
  "atomic account budget counts UTF-8 and NUL bytes, rolls imports back and maps note failures",
  () =>
    Effect.gen(function* accountBudget() {
      const stores = yield* sqlJsJobStore;
      yield* Effect.gen(function* proveBudget() {
        const sql = yield* SqlExecutor;
        const store = yield* TrackerStore;

        const seed = (id: string, notes: string) =>
          statement(
            "INSERT INTO tracked_jobs (account_id, job_id, stage, notes, title, company, location, url, saved_at, moved_at) VALUES (?, ?, 'Saved', ? || char(0), '', '', '', '', 0, 0)",
            [account.id, id, notes]
          );

        yield* sql.batch("seed byte boundary", [
          seed("boundary", "界".repeat(1_398_000)),
        ]);
        const before = yield* store.list(account.id);

        const failed = yield* Effect.result(
          store.importMissing(
            account.id,
            [
              request("fits"),
              {
                ...request("overflow"),
                snapshot: {
                  company: "界".repeat(500),
                  location: "界".repeat(500),
                  title: "界".repeat(500),
                  url: "界".repeat(500),
                },
              },
            ],
            1
          )
        );

        expect(failed).toStrictEqual(
          Result.fail(new TrackerStorageFull({ limit: TRACKER_BYTE_LIMIT }))
        );
        expect(yield* store.list(account.id)).toStrictEqual(before);

        const totals = yield* sql.all(
          "measure UTF-8 payload",
          statement(
            `SELECT SUM(${bytes}) AS bytes FROM tracked_jobs WHERE account_id = ?`,
            [account.id]
          ),
          Schema.Struct({ bytes: Schema.Finite })
        );

        expect(totals[0]?.bytes).toBe(4_194_009);
        yield* store.track(account.id, request("short-note"), 1);

        const failure = yield* Effect.flip(
          noteTrackedJob.handler({
            jobId: "short-note",
            notes: "界".repeat(2000),
          })
        );

        expect(failure).toStrictEqual(
          new TrackerStorageFull({ limit: TRACKER_BYTE_LIMIT })
        );
        expect(
          (yield* store.list(account.id)).find(
            ({ jobId }) => jobId === "short-note"
          )?.notes
        ).toBe("");

        const other = yield* Schema.decodeEffect(Account)({
          email: "other@example.com",
          id: "other",
          name: "Other",
        });

        yield* store.track(other.id, request("unaffected-owner"), 1);
        expect(yield* store.list(other.id)).toHaveLength(1);
        yield* sql.batch("reach exact payload cap", [
          statement(
            "UPDATE tracked_jobs SET notes = notes || ? WHERE account_id = ? AND job_id = 'boundary'",
            [
              "x".repeat(
                295 -
                  new TextEncoder().encode(
                    `short-note${snapshot.company}${snapshot.location}${snapshot.title}${snapshot.url}`
                  ).byteLength
              ),
              account.id,
            ]
          ),
        ]);

        const exact = yield* sql.all(
          "read exact payload cap",
          statement(
            `SELECT SUM(${bytes}) AS bytes FROM tracked_jobs WHERE account_id = ?`,
            [account.id]
          ),
          Schema.Struct({ bytes: Schema.Finite })
        );

        expect(exact[0]?.bytes).toBe(TRACKER_BYTE_LIMIT);

        const nextByte = yield* Effect.flip(
          sql.batch("refuse one extra payload byte", [
            statement(
              "UPDATE tracked_jobs SET notes = notes || 'x' WHERE account_id = ? AND job_id = 'boundary'",
              [account.id]
            ),
          ])
        );

        expect(nextByte.message).toContain("tracker_storage_full");

        yield* untrackJob.handler({ jobId: "boundary" });
        expect(
          yield* noteTrackedJob.handler({
            jobId: "short-note",
            notes: "界".repeat(2000),
          })
        ).toHaveLength(1);
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(CurrentViewer, viewer)
      );
    })
);

it.effect(
  "500 typical snapshots with full CJK notes fit the measured account budget",
  () =>
    Effect.gen(function* typicalCapacity() {
      const stores = yield* sqlJsJobStore;
      yield* Effect.gen(function* fillTracker() {
        const store = yield* TrackerStore;
        yield* Effect.forEach(
          Array.chunksOf(
            Array.makeBy(500, (index) => request(`g:${index}`)),
            200
          ),
          (jobs) => store.importMissing(account.id, jobs, 0)
        );
        yield* Effect.forEach(
          Array.makeBy(500, (index) => `g:${index}`),
          (jobId) => store.note(account.id, jobId, "界".repeat(2000))
        );
        expect(yield* store.list(account.id)).toHaveLength(500);
      }).pipe(Effect.provide(stores));
    })
);

it.effect(
  "migration preserves oversized legacy IDs for reads, stage moves, notes and deletion",
  () =>
    Effect.gen(function* legacyStorage() {
      const legacyId = "i".repeat(1000);

      const stores = yield* seededSqlJsJobStore({
        "0005_tracked_jobs.sql": `INSERT INTO tracked_jobs (account_id, job_id, stage, notes, title, company, location, url, saved_at, moved_at) VALUES ('storage', '${legacyId}', 'Saved', 'legacy', '', '', '', '', 0, 0);`,
      });

      yield* Effect.gen(function* legacyCompatibility() {
        expect(
          yield* Schema.encodeEffect(TrackedJobs)(
            yield* trackedJobs.handler({})
          )
        ).toHaveLength(1);

        const moved = yield* trackJob.handler({
          ...request(legacyId),
          stage: "Applied",
        });

        expect(moved[0]?.stage).toBe("Applied");

        const store = yield* TrackerStore;

        const otherOwner = yield* Schema.decodeEffect(Account)({
          email: "legacy-other@example.com",
          id: "legacy-other",
          name: "Other",
        });

        expect(
          yield* Effect.flip(store.track(otherOwner.id, request(legacyId), 0))
        ).toStrictEqual(new TrackerJobIdTooLong({ limit: 200 }));
        expect(yield* store.list(otherOwner.id)).toStrictEqual([]);

        const noted = yield* noteTrackedJob.handler({
          jobId: legacyId,
          notes: "edited",
        });

        expect(noted[0]?.notes).toBe("edited");
        expect(yield* untrackJob.handler({ jobId: legacyId })).toStrictEqual(
          []
        );
      }).pipe(
        Effect.provide(stores),
        Effect.provideService(CurrentViewer, viewer)
      );
    })
);

it.effect(
  "new IDs use the same 200 UTF-8-byte bound for non-ASCII and embedded NUL, scoped to their owner",
  () =>
    Effect.gen(function* newIdBudget() {
      const stores = yield* sqlJsJobStore;
      yield* Effect.gen(function* byteIds() {
        const store = yield* TrackerStore;
        const sql = yield* SqlExecutor;

        for (const id of [`${"界".repeat(66)}ab`, "😀".repeat(50)]) {
          expect(Schema.is(TrackRequest)(request(id))).toBe(true);
          yield* store.track(account.id, request(id), 0);
        }

        for (const id of ["界".repeat(67), "😀".repeat(51)]) {
          expect(Schema.is(TrackRequest)(request(id))).toBe(false);
          expect(
            yield* Effect.flip(store.track(account.id, request(id), 0))
          ).toStrictEqual(new TrackerJobIdTooLong({ limit: 200 }));
        }

        expect(Schema.is(TrackRequest)(request(`${"a".repeat(199)}\0`))).toBe(
          true
        );
        expect(Schema.is(TrackRequest)(request(`${"a".repeat(199)}\0z`))).toBe(
          false
        );
        yield* sql.batch("seed exact NUL ID boundary", [
          statement(
            "INSERT INTO tracked_jobs (account_id, job_id, stage, title, company, location, url, saved_at, moved_at) VALUES (?, ? || char(0), 'Saved', '', '', '', '', 0, 0)",
            [account.id, "a".repeat(199)]
          ),
        ]);

        const nulOverflow = yield* Effect.flip(
          sql.batch("refuse ID after NUL", [
            statement(
              "INSERT INTO tracked_jobs (account_id, job_id, stage, title, company, location, url, saved_at, moved_at) VALUES (?, ? || char(0) || 'z', 'Saved', '', '', '', '', 0, 0)",
              [account.id, "a".repeat(199)]
            ),
          ])
        );

        expect(nulOverflow.message).toContain("tracker_job_id_too_long");
      }).pipe(Effect.provide(stores));
    })
);

it.effect(
  "over-budget legacy accounts keep their rows and can reduce notes or delete",
  () =>
    Effect.gen(function* grandfatheredBudget() {
      const stores = yield* seededSqlJsJobStore({
        "0005_tracked_jobs.sql": `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 350)
        INSERT INTO tracked_jobs (account_id, job_id, stage, notes, title, company, location, url, saved_at, moved_at)
        SELECT 'storage', 'legacy-' || i, 'Saved', ${cjk(2000)}, ${cjk(500)}, ${cjk(500)}, ${cjk(500)}, ${cjk(500)}, 0, 0 FROM n;`,
      });

      yield* Effect.gen(function* reduceGrandfathered() {
        const store = yield* TrackerStore;
        expect(yield* store.list(account.id)).toHaveLength(350);
        expect(
          yield* Effect.flip(store.track(account.id, request("new"), 0))
        ).toStrictEqual(new TrackerStorageFull({ limit: TRACKER_BYTE_LIMIT }));
        yield* store.track(
          account.id,
          {
            jobId: "legacy-1",
            snapshot: {
              company: "界".repeat(500),
              location: "界".repeat(500),
              title: "界".repeat(500),
              url: "界".repeat(500),
            },
            stage: "Interviewing",
          },
          1
        );

        expect(
          (yield* store.list(account.id)).find(
            ({ jobId }) => jobId === "legacy-1"
          )?.stage
        ).toBe("Interviewing");

        yield* store.note(account.id, "legacy-1", "shorter");
        yield* store.untrack(account.id, "legacy-2");
        expect(yield* store.list(account.id)).toHaveLength(349);
      }).pipe(Effect.provide(stores));
    })
);
