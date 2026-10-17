import { EnrichmentQueue, EnrichmentQueueUnavailable } from "@rat-stack/core";
import { Array, Effect, Layer, pipe } from "effect";

export const MAX_BATCH_MESSAGES = 100;

export type SendBatch = (
  messages: readonly { readonly body: { readonly id: string } }[]
) => Effect.Effect<void, { readonly message: string }>;

export const enrichmentQueueLayer = (sendBatch: SendBatch) =>
  Layer.succeed(
    EnrichmentQueue,
    EnrichmentQueue.of({
      enqueue: (ids) =>
        Effect.forEach(
          Array.chunksOf(ids, MAX_BATCH_MESSAGES),
          (chunk) =>
            sendBatch(
              pipe(
                chunk,
                Array.map((id) => ({ body: { id } }))
              )
            ),
          { discard: true }
        ).pipe(
          Effect.mapError(
            (failure) =>
              new EnrichmentQueueUnavailable({
                message: failure.message.slice(0, 500),
              })
          )
        ),
    })
  );
