import { toRpc } from "@rat-stack/capability/rpc";
import { capabilities, runIngest } from "@rat-stack/core";
import { postingFeedsLayer } from "@rat-stack/job-sources";
import { d1JobStoreLayer, JobsDatabase } from "@rat-stack/job-store/d1";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

export const rpcProjection = toRpc(capabilities);

export const INGEST_SCHEDULE = "*/20 * * * *";

export const DEFAULT_FEEDS_PER_RUN = 20;

export const DEFAULT_FEED_CONCURRENCY = 6;

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

    const ingestLayer = Layer.mergeAll(
      storeLayer,
      postingFeedsLayer().pipe(Layer.provide(FetchHttpClient.layer))
    );

    yield* Cloudflare.Workers.cron(INGEST_SCHEDULE, (controller) =>
      runIngest({ feedConcurrency, feedsPerRun }).pipe(
        Effect.tap(({ outcomes, receipt }) =>
          Effect.logInfo("ingest finished", {
            failures: outcomes.filter((outcome) => outcome.error !== null),
            receipt,
          })
        ),
        Effect.tapError((error) => Effect.logError("ingest failed", error)),
        Effect.annotateLogs({
          cron: controller.cron,
          scheduledTime: controller.scheduledTime,
        }),
        Effect.provide(ingestLayer)
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
        Cloudflare.Workers.CronEventSourceLive
      )
    )
  )
) {}
