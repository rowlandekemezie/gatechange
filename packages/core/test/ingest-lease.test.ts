import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";
import { TestClock } from "effect/testing";

import {
  INGEST_INTERVAL_MINUTES,
  INGEST_LEASE_MILLIS,
  IngestInProgress,
  JobStore,
  JobStoreUnavailable,
  PostingFeeds,
  runIngest,
} from "../src/index.js";
import { makeMemoryJobStore } from "./memory-job-store.js";

const plan = { feedConcurrency: 1, feedsPerRun: 1 };

const feeds = Layer.succeed(PostingFeeds, {
  catalog: [],
  fetch: () => Effect.die("an empty catalog must not fetch"),
});

const failure = (operation: string) =>
  new JobStoreUnavailable({ message: "database unavailable", operation });

describe("ingest lease finalization", () => {
  it.effect(
    "release failure preserves the committed receipt and warns separately",
    () =>
      Effect.gen(function* releaseFailure() {
        const memory = yield* makeMemoryJobStore;
        const store = yield* JobStore.pipe(Effect.provide(memory.layer));
        const warnings: unknown[] = [];

        const result = yield* runIngest(plan).pipe(
          Effect.provide(
            Layer.mergeAll(
              feeds,
              Layer.succeed(JobStore, {
                ...store,
                releaseIngest: () => Effect.fail(failure("releaseIngest")),
              }),
              Logger.layer([
                Logger.make(({ fiber, logLevel, message }) => {
                  if (logLevel === "Warn") {
                    warnings.push({
                      fields: fiber.getRef(References.CurrentLogAnnotations),
                      message,
                    });
                  }
                }),
              ])
            )
          )
        );

        expect(memory.runs()).toStrictEqual([result.receipt]);
        expect(result.receipt.outcome).toBe("Succeeded");
        expect(warnings).toStrictEqual([
          {
            fields: { operation: "releaseIngest", startedAt: 0 },
            message: ["ingest lease release failed; lease will expire"],
          },
        ]);
      })
  );

  it.effect(
    "a failed receipt write releases the lease for a run two minutes later",
    () =>
      Effect.gen(function* failedBody() {
        const memory = yield* makeMemoryJobStore;
        const store = yield* JobStore.pipe(Effect.provide(memory.layer));
        const bodyFailure = failure("recordRun");

        const rejected = yield* runIngest(plan).pipe(
          Effect.provide(
            Layer.merge(
              feeds,
              Layer.succeed(JobStore, {
                ...store,
                recordRun: () => Effect.fail(bodyFailure),
              })
            )
          ),
          Effect.flip
        );

        expect(rejected).toStrictEqual(bodyFailure);
        expect(memory.runs()).toHaveLength(0);
        yield* TestClock.adjust("2 minutes");

        const accepted = yield* runIngest(plan).pipe(
          Effect.provide(Layer.merge(feeds, memory.layer))
        );

        expect(accepted.receipt.startedAt).toBe(120_000);
        expect(memory.runs()).toStrictEqual([accepted.receipt]);
      })
  );

  it.effect("a rejected overlapping run cannot release the active lease", () =>
    Effect.gen(function* rejectedClaim() {
      const memory = yield* makeMemoryJobStore;
      const store = yield* JobStore.pipe(Effect.provide(memory.layer));
      expect(yield* store.claimIngest(0, INGEST_LEASE_MILLIS)).toBe(true);
      yield* TestClock.adjust("1 minute");

      const rejected = yield* runIngest(plan).pipe(
        Effect.provide(Layer.merge(feeds, memory.layer)),
        Effect.flip
      );

      expect(rejected).toBeInstanceOf(IngestInProgress);
      yield* TestClock.adjust("1 minute");
      expect(
        yield* store.claimIngest(120_000, 120_000 + INGEST_LEASE_MILLIS)
      ).toBe(false);
      expect(memory.runs()).toHaveLength(0);
    })
  );

  it.effect(
    "the existing lease expires before the next scheduled cron interval",
    () =>
      Effect.sync(() => {
        expect(INGEST_LEASE_MILLIS).toBeGreaterThan(0);
        expect(INGEST_LEASE_MILLIS).toBeLessThan(
          INGEST_INTERVAL_MINUTES * 60_000
        );
      })
  );
});
