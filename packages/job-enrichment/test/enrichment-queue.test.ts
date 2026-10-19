import { describe, expect, it } from "@effect/vitest";
import { EnrichmentQueue, EnrichmentQueueUnavailable } from "@rat-stack/core";
import { Effect } from "effect";

import {
  enrichmentQueueLayer,
  loggedBody,
  MAX_LOGGED_BODY_CHARS,
} from "../src/index.js";
import type { SendBatch } from "../src/index.js";

const recording = (fails = false) => {
  const batches: (readonly { readonly body: { readonly id: string } }[])[] = [];

  const sendBatch: SendBatch = (messages) => {
    batches.push(messages);

    return fails ? Effect.fail({ message: "queue is gone" }) : Effect.void;
  };

  return { batches, sendBatch };
};

const enqueueWith = (sendBatch: SendBatch, ids: readonly string[]) =>
  Effect.gen(function* enqueue() {
    const queue = yield* EnrichmentQueue;

    yield* queue.enqueue(ids);
  }).pipe(Effect.provide(enrichmentQueueLayer(sendBatch)));

const idsUpTo = (count: number) =>
  Array.from({ length: count }, (_, index) => `greenhouse:acme:${index}`);

describe("enrichment queue", () => {
  it.effect("sends id bodies in batches of at most 100", () => {
    const fake = recording();

    return Effect.gen(function* sendChunks() {
      yield* enqueueWith(fake.sendBatch, idsUpTo(250));

      expect(fake.batches.map((batch) => batch.length)).toStrictEqual([
        100, 100, 50,
      ]);
      expect(fake.batches.flat()).toStrictEqual(
        idsUpTo(250).map((id) => ({ body: { id } }))
      );
    });
  });

  it.effect("sends nothing for an empty list", () => {
    const fake = recording();

    return Effect.gen(function* sendNothing() {
      yield* enqueueWith(fake.sendBatch, []);

      expect(fake.batches).toStrictEqual([]);
    });
  });

  it.effect("reports a send failure as EnrichmentQueueUnavailable", () =>
    Effect.gen(function* failSend() {
      const failure = yield* Effect.flip(
        enqueueWith(recording(true).sendBatch, idsUpTo(3))
      );

      expect(failure).toStrictEqual(
        new EnrichmentQueueUnavailable({ message: "queue is gone" })
      );
    })
  );
});

describe("loggedBody", () => {
  it.each([
    ["a long body", JSON.stringify({ id: "x".repeat(10_000) }), 200],
    ["a short body", JSON.stringify({ id: "greenhouse:acme:1" }), 26],
  ] as const)("%s is logged in at most 200 characters", (_, body, length) => {
    expect(loggedBody(body)).toHaveLength(length);
    expect(MAX_LOGGED_BODY_CHARS).toBe(200);
  });
});
