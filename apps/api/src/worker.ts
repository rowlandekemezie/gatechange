import { BetterAuth } from "@alchemy.run/better-auth";
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import {
  AUTH_BASE_PATH,
  authOptions,
  magicLinkEmail,
  makeAccountStore,
} from "@rat-stack/accounts";
import type { SocialCredentials } from "@rat-stack/accounts";
import { toRpc } from "@rat-stack/capability/rpc";
import {
  AccountStore,
  capabilities,
  CurrentViewer,
  runIngest,
  SocialProvider,
  Viewer,
} from "@rat-stack/core";
import type { SocialProviderValue } from "@rat-stack/core";
import { postingFeedsLayer } from "@rat-stack/job-sources";
import { d1JobStoreLayer, JobsDatabase } from "@rat-stack/job-store/d1";
import * as Cloudflare from "alchemy/Cloudflare";
import * as RuntimeContext from "alchemy/RuntimeContext";
import { Config, Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient, HttpServerRequest } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

export const rpcProjection = toRpc(capabilities);

export const INGEST_SCHEDULE = "*/20 * * * *";

export const DEFAULT_FEEDS_PER_RUN = 20;

export const DEFAULT_FEED_CONCURRENCY = 6;

export const MAGIC_LINK_SENDER = "sign-in@rowlandekemezie.com";

export const SITE_ORIGIN = "https://jobs.rowlandekemezie.com";

export const AUTH_HOSTS = ["jobs.rowlandekemezie.com", "localhost:*"];

const socialCredentials = (prefix: string) =>
  Config.all({
    clientId: Config.String(`${prefix}_CLIENT_ID`),
    clientSecret: Config.Redacted(`${prefix}_CLIENT_SECRET`),
  }).pipe(
    Config.map(({ clientId, clientSecret }): SocialCredentials => ({
      clientId,
      clientSecret: Redacted.value(clientSecret),
    })),
    Config.option
  );

const isAuthPath = (url: string) =>
  url === AUTH_BASE_PATH || url.startsWith(`${AUTH_BASE_PATH}/`);

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

    const secret = yield* Config.Redacted("BETTER_AUTH_SECRET");
    const github = yield* socialCredentials("GITHUB");
    const google = yield* socialCredentials("GOOGLE");

    const social: Partial<Record<SocialProviderValue, SocialCredentials>> = {
      ...Option.match(github, {
        onNone: () => ({}),
        onSome: (credentials) => ({ github: credentials }),
      }),
      ...Option.match(google, {
        onNone: () => ({}),
        onSome: (credentials) => ({ google: credentials }),
      }),
    };

    const mailer = yield* Cloudflare.Email.Send(
      yield* Cloudflare.Email.SendEmail("MagicLinkEmail")
    );

    const runPromise = Effect.runPromiseWith(yield* Effect.context());

    const auth = yield* BetterAuth({
      ...authOptions({
        allowedHosts: AUTH_HOSTS,
        fallbackOrigin: SITE_ORIGIN,
        // @effect-diagnostics-next-line asyncFunction:off -- better-auth awaits a Promise-returning sender.
        sendMagicLink: async (request) => {
          await runPromise(
            mailer
              .send(magicLinkEmail(MAGIC_LINK_SENDER, request))
              .pipe(Effect.provide(RuntimeContext.RuntimeContext.phantom))
          );
        },
        social,
      }),
      migrate: false,
      secret,
    });

    const accountStore = makeAccountStore(
      (cookie) =>
        auth
          .getSession(new Headers({ cookie }))
          .pipe(Effect.provide(RuntimeContext.RuntimeContext.phantom)),
      {
        socialProviders: SocialProvider.literals.filter(
          (provider) => social[provider] !== undefined
        ),
      }
    );

    const rpc = RpcServer.toHttpEffect(rpcProjection.group).pipe(
      Effect.provide(
        Layer.mergeAll(rpcProjection.layer, RpcSerialization.layerJson).pipe(
          Layer.provide(
            Layer.mergeAll(
              storeLayer,
              Layer.succeed(AccountStore, accountStore)
            )
          )
        )
      )
    );

    const viewerOf = (request: HttpServerRequest.HttpServerRequest) =>
      accountStore
        .viewerOf(request.headers.cookie ?? "")
        .pipe(
          Effect.catchTag("AccountStoreUnavailable", (failure) =>
            Effect.logWarning("session lookup failed", failure).pipe(
              Effect.as(Viewer.Anonymous())
            )
          )
        );

    const handle = Effect.gen(function* handle() {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if (isAuthPath(request.url)) {
        return yield* auth.fetch;
      }

      const viewer = yield* viewerOf(request);

      return yield* Effect.flatten(rpc).pipe(
        Effect.provideService(CurrentViewer, viewer)
      );
    });

    // @effect-diagnostics-next-line returnEffectInGen:off -- Alchemy's RPC Worker initialization returns its request Effect.
    return Effect.succeed(handle);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Workers.CronEventSourceLive,
        Cloudflare.Email.SendBinding,
        CloudflareD1(JobsDatabase)
      )
    )
  )
) {}
