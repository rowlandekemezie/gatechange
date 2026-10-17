import { toRpc } from "@rat-stack/capability/rpc";
import {
  capabilities,
  DEFAULT_FEEDS_PER_RUN,
  enqueueNewListings,
  enrichListing,
  EnrichmentOutcome,
  INGEST_INTERVAL_MINUTES,
  retryableSkips,
  runIngest,
} from "@rat-stack/core";
import {
  enrichmentModel,
  enrichmentQueueLayer,
  listingEnricherLayer,
} from "@rat-stack/job-enrichment";
import { postingFeedsLayer, postingTextsLayer } from "@rat-stack/job-sources";
import { d1JobStoreLayer, JobsDatabase } from "@rat-stack/job-store/d1";
import * as Cloudflare from "alchemy/Cloudflare";
import * as RuntimeContext from "alchemy/RuntimeContext";
import { Array, Config, Effect, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

export const rpcProjection = toRpc(capabilities);

export const INGEST_SCHEDULE = `*/${INGEST_INTERVAL_MINUTES} * * * *`;

export const DEFAULT_FEED_CONCURRENCY = 6;

export const ENRICHMENT_BATCH_SIZE = 10;

export const ENRICHMENT_MAX_RETRIES = 3;

export const ENRICHMENT_RETRY_DELAY_SECONDS = 300;

export const EnrichmentQueue = Cloudflare.Queues.Queue("EnrichmentQueue");

const EnrichmentMessage = Schema.Struct({ id: Schema.NonEmptyString });

const acknowledge = (message: Cloudflare.Queues.Message) =>
  Effect.sync(() => {
    message.ack();
  });

const retryLater = (message: Cloudflare.Queues.Message) =>
  Effect.sync(() => {
    message.retry({ delaySeconds: ENRICHMENT_RETRY_DELAY_SECONDS });
  });

const enrichMessage = (message: Cloudflare.Queues.Message) =>
  Option.match(Schema.decodeUnknownOption(EnrichmentMessage)(message.body), {
    onNone: () =>
      Effect.logWarning("enrichment message dropped: no listing id", {
        body: message.body,
      }).pipe(Effect.andThen(acknowledge(message))),
    onSome: ({ id }) =>
      enrichListing(id).pipe(
        Effect.flatMap(
          EnrichmentOutcome.$match({
            Enriched: (enriched) =>
              Effect.logInfo("listing enriched", enriched).pipe(
                Effect.andThen(acknowledge(message))
              ),
            Skipped: (skipped) =>
              Array.contains(retryableSkips, skipped.reason)
                ? Effect.logWarning("enrichment will retry", skipped).pipe(
                    Effect.andThen(retryLater(message))
                  )
                : Effect.logInfo("enrichment skipped", skipped).pipe(
                    Effect.andThen(acknowledge(message))
                  ),
          })
        ),
        Effect.catchTag("JobStoreUnavailable", (unavailable) =>
          Effect.logError("enrichment will retry: store unavailable", {
            id,
            unavailable,
          }).pipe(Effect.andThen(retryLater(message)))
        )
      ),
  });

export default class JobsBackend extends Cloudflare.Workers.RpcWorker<JobsBackend>()(
  "JobsBackend",
  {
    main: import.meta.url,
    observability: { enabled: true },
    schema: rpcProjection.group,
    workersDev: false,
  },
  Effect.gen(function* jobsBackend() {
    const database = yield* JobsDatabase;
    const client = yield* Cloudflare.D1.QueryDatabase(database);
    const storeLayer = d1JobStoreLayer(client);

    const feedsPerRun = yield* Config.Int("INGEST_FEEDS_PER_RUN").pipe(
      Config.withDefault(DEFAULT_FEEDS_PER_RUN)
    );

    const feedConcurrency = yield* Config.Int("INGEST_FEED_CONCURRENCY").pipe(
      Config.withDefault(DEFAULT_FEED_CONCURRENCY)
    );

    const queue = yield* EnrichmentQueue;
    const producer = yield* Cloudflare.Queues.WriteQueue(queue);
    const ai = yield* Cloudflare.Workers.AI();
    const model = yield* enrichmentModel;

    const queueLayer = enrichmentQueueLayer((messages) =>
      producer
        .sendBatch(messages)
        .pipe(Effect.provide(RuntimeContext.RuntimeContext.phantom))
    );

    const enricherLayer = listingEnricherLayer({
      model,
      run: (name, request) =>
        ai
          .run(name, request)
          .pipe(Effect.provide(RuntimeContext.RuntimeContext.phantom)),
    });

    const ingestLayer = Layer.mergeAll(
      storeLayer,
      queueLayer,
      postingFeedsLayer().pipe(Layer.provide(FetchHttpClient.layer))
    );

    const enrichmentLayer = Layer.mergeAll(
      storeLayer,
      enricherLayer,
      postingTextsLayer.pipe(Layer.provide(FetchHttpClient.layer))
    );

    yield* Cloudflare.Workers.cron(INGEST_SCHEDULE, (controller) =>
      runIngest({ feedConcurrency, feedsPerRun }).pipe(
        Effect.tap(({ outcomes, receipt }) =>
          Effect.logInfo("ingest finished", {
            failures: outcomes.filter((outcome) => outcome.error !== null),
            receipt,
          })
        ),
        Effect.tap(({ receipt }) =>
          enqueueNewListings(receipt.startedAt).pipe(
            Effect.tap((queued) =>
              Effect.logInfo("new listings queued for enrichment", { queued })
            ),
            Effect.catch((error) =>
              Effect.logError("enrichment enqueue failed", error)
            )
          )
        ),
        Effect.catchTag("IngestInProgress", (busy) =>
          Effect.logInfo("ingest skipped: another run holds the lease", busy)
        ),
        Effect.tapError((error) => Effect.logError("ingest failed", error)),
        Effect.annotateLogs({
          cron: controller.cron,
          scheduledTime: controller.scheduledTime,
        }),
        Effect.provide(ingestLayer)
      )
    );

    yield* Cloudflare.Queues.consumeQueueMessages(
      queue,
      {
        batchSize: ENRICHMENT_BATCH_SIZE,
        maxRetries: ENRICHMENT_MAX_RETRIES,
      },
      (messages) =>
        Stream.runForEach(messages, enrichMessage).pipe(
          Effect.provide(enrichmentLayer)
        )
    );

    // @effect-diagnostics-next-line returnEffectInGen:off -- Alchemy's RPC Worker initialization returns its request Effect.
    return RpcServer.toHttpEffect(rpcProjection.group).pipe(
      Effect.provide(
        Layer.mergeAll(rpcProjection.layer, RpcSerialization.layerJson).pipe(
          Layer.provide(storeLayer)
        )
      )
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Workers.CronEventSourceLive,
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Queues.EventSourceLive,
        Cloudflare.Workers.AIBinding
      )
    )
  )
) {}
