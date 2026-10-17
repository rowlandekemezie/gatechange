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
  DEFAULT_FEEDS_PER_RUN,
  INGEST_INTERVAL_MINUTES,
  runIngest,
  SocialProvider,
  Viewer,
} from "@rat-stack/core";
import type { ViewerValue } from "@rat-stack/core";
import { postingFeedsLayer } from "@rat-stack/job-sources";
import { d1JobStoreLayer, JobsDatabase } from "@rat-stack/job-store/d1";
import * as Cloudflare from "alchemy/Cloudflare";
import * as RuntimeContext from "alchemy/RuntimeContext";
import {
  Config,
  Effect,
  Layer,
  Option,
  Record,
  Redacted,
  Schema,
} from "effect";
import { FetchHttpClient, HttpServerRequest } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

export const rpcProjection = toRpc(capabilities);

export const INGEST_SCHEDULE = `*/${INGEST_INTERVAL_MINUTES} * * * *`;

export const DEFAULT_FEED_CONCURRENCY = 6;

export const MAGIC_LINK_SENDER = "sign-in@rowlandekemezie.com";

export const SITE_ORIGIN = "https://jobs.rowlandekemezie.com";

export const SITE_HOST = "jobs.rowlandekemezie.com";

const extraAuthHosts = Config.String("AUTH_EXTRA_HOSTS").pipe(
  Config.withDefault(""),
  Config.map((hosts) =>
    hosts
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host !== "")
  )
);

export const MIN_AUTH_SECRET_LENGTH = 32;

const authSecret = Config.schema(
  Schema.Redacted(
    Schema.String.check(Schema.isMinLength(MIN_AUTH_SECRET_LENGTH))
  ),
  "BETTER_AUTH_SECRET"
);

const socialCredentials = (prefix: string) =>
  Config.all({
    clientId: Config.String(`${prefix}_CLIENT_ID`).pipe(Config.withDefault("")),
    clientSecret: Config.Redacted(`${prefix}_CLIENT_SECRET`).pipe(
      Config.withDefault(Redacted.make(""))
    ),
  }).pipe(
    Config.map(({ clientId, clientSecret }) =>
      clientId === "" || Redacted.value(clientSecret) === ""
        ? Option.none<SocialCredentials>()
        : Option.some({
            clientId,
            clientSecret: Redacted.value(clientSecret),
          })
    )
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

    const secret = yield* authSecret;

    const social = Record.getSomes({
      github: yield* socialCredentials("GITHUB"),
      google: yield* socialCredentials("GOOGLE"),
    });

    const authHosts = [SITE_HOST, ...(yield* extraAuthHosts)];

    const mailer = yield* Cloudflare.Email.Send(
      yield* Cloudflare.Email.SendEmail("MagicLinkEmail", {
        allowedSenderAddresses: [MAGIC_LINK_SENDER],
      })
    );

    const runPromise = Effect.runPromiseWith(yield* Effect.context());

    const auth = yield* BetterAuth({
      ...authOptions({
        allowedHosts: authHosts,
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
        auth.api
          .getSession({
            headers: new Headers({ cookie }),
            query: { disableRefresh: true },
          })
          .pipe(Effect.provide(RuntimeContext.RuntimeContext.phantom)),
      {
        socialProviders: SocialProvider.literals.filter(
          (provider) => social[provider] !== undefined
        ),
      }
    );

    const serveRpc = (viewer: ViewerValue) =>
      Effect.flatten(
        RpcServer.toHttpEffect(rpcProjection.group).pipe(
          Effect.provide(
            Layer.mergeAll(
              rpcProjection.layer,
              RpcSerialization.layerJson
            ).pipe(
              Layer.provide(
                Layer.mergeAll(
                  storeLayer,
                  Layer.succeed(AccountStore, accountStore),
                  Layer.succeed(CurrentViewer, viewer)
                )
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

      return yield* serveRpc(yield* viewerOf(request));
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
