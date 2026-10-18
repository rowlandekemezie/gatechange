import { toRpc } from "@rat-stack/capability/rpc";
import {
  capabilities,
  DEFAULT_FEEDS_PER_RUN,
  enqueueUnenriched,
  enrichListing,
  EnrichmentOutcome,
  INGEST_INTERVAL_MINUTES,
  runIngest,
  skipHandling,
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
import { Config, Effect, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

export const rpcProjection = toRpc(capabilities);

export const INGEST_SCHEDULE = `*/${INGEST_INTERVAL_MINUTES} * * * *`;

export const DEFAULT_FEED_CONCURRENCY = 6;

export const ENRICHMENT_BATCH_SIZE = 10;

export const ENRICHMENT_MAX_RETRIES = 3;

export const DEFAULT_ENRICHMENT_SWEEP_LIMIT = 8;

export const DEFAULT_ENRICHMENT_SWEEP_HOURS = 24;

export const EnrichmentQueue = Cloudflare.Queues.Queue("EnrichmentQueue");

const EnrichmentMessage = Schema.Struct({ id: Schema.NonEmptyString });

const enrichMessage = (message: Cloudflare.Queues.Message) =>
  Option.match(Schema.decodeUnknownOption(EnrichmentMessage)(message.body), {
    onNone: () =>
      Effect.logWarning(
        `enrichment message dropped: no listing id, body=${JSON.stringify(message.body)}`
      ),
    onSome: ({ id }) =>
      enrichListing(id).pipe(
        Effect.flatMap(
          EnrichmentOutcome.$match({
            Enriched: ({ enrichment }) =>
              Effect.logInfo(
                `listing enriched id=${id} model=${enrichment.model}`
              ),
            Skipped: ({ detail, reason }) =>
              Effect.logInfo(
                `enrichment skipped id=${id} reason=${reason} handling=${skipHandling[reason]} detail=${JSON.stringify(detail)}`
              ),
          })
        ),
        Effect.catchTag("JobStoreUnavailable", (unavailable) =>
          Effect.logError(
            `enrichment left for the next sweep: store unavailable id=${id} detail=${JSON.stringify(unavailable.message)}`
          )
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

    const sweepLimit = yield* Config.Int("ENRICHMENT_SWEEP_LIMIT").pipe(
      Config.withDefault(DEFAULT_ENRICHMENT_SWEEP_LIMIT)
    );

    const sweepHours = yield* Config.Int("ENRICHMENT_SWEEP_HOURS").pipe(
      Config.withDefault(DEFAULT_ENRICHMENT_SWEEP_HOURS)
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
          Effect.logInfo(
            `ingest finished outcome=${receipt.outcome} feeds=${receipt.feedsAttempted} failed=${receipt.feedsFailed} upserted=${receipt.jobsUpserted} pruned=${receipt.jobsPruned} failures=${JSON.stringify(
              outcomes.flatMap(({ error, key }) =>
                error === null ? [] : [`${key}: ${error}`]
              )
            )}`
          )
        ),
        Effect.tap(({ receipt }) =>
          enqueueUnenriched({
            limit: sweepLimit,
            now: receipt.startedAt,
            windowHours: sweepHours,
          }).pipe(
            Effect.tap((queued) =>
              Effect.logInfo(`listings queued for enrichment queued=${queued}`)
            ),
            Effect.catch((error) =>
              Effect.logError(
                `enrichment enqueue failed tag=${error._tag} detail=${JSON.stringify(error.message)}`
              )
            )
          )
        ),
        Effect.catchTag("IngestInProgress", (busy) =>
          Effect.logInfo(
            `ingest skipped: another run holds the lease startedAt=${busy.startedAt}`
          )
        ),
        Effect.tapError((error) =>
          Effect.logError(
            `ingest failed tag=${error._tag} detail=${JSON.stringify(error.message)}`
          )
        ),
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
        messages.pipe(
          Stream.mapEffect(enrichMessage, {
            concurrency: ENRICHMENT_BATCH_SIZE,
            unordered: true,
          }),
          Stream.runDrain,
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
