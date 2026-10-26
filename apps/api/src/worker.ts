import { BetterAuth } from "@alchemy.run/better-auth";
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import {
  authOptions,
  authSecret,
  logSendFailure,
  magicLinkEmail,
  makeAccountStore,
} from "@rat-stack/accounts";
import type { SocialCredentials } from "@rat-stack/accounts";
import { stripeWebhookResponse } from "@rat-stack/billing";
import { toRpc } from "@rat-stack/capability/rpc";
import {
  AccountStore,
  AlertStore,
  Billing,
  capabilities,
  CurrentViewer,
  DEFAULT_FEEDS_PER_RUN,
  DigestMailer,
  enqueueUnenriched,
  enrichListing,
  EnrichmentOutcome,
  INGEST_INTERVAL_MINUTES,
  isPullRequestStage,
  publicOriginOf,
  runDigests,
  runIngest,
  runInstantAlerts,
  skipHandling,
  sweepLimitOf,
  siteHostsOf,
  SITE_HOSTNAME,
  SITE_ORIGIN,
  SocialProvider,
} from "@rat-stack/core";
import type { ViewerValue } from "@rat-stack/core";
import {
  makeDigestMailer,
  unsubscribePage,
  verifyUnsubscribeToken,
} from "@rat-stack/digest-mailer";
import {
  enrichmentModel,
  enrichmentQueueLayer,
  listingEnricherLayer,
  loggedBody,
} from "@rat-stack/job-enrichment";
import { postingFeedsLayer, postingTextsLayer } from "@rat-stack/job-sources";
import {
  d1AgentTokenStoreLayer,
  d1AlertStoreLayer,
  d1BillingStoreLayer,
  d1JobStoreLayer,
  JobsDatabase,
} from "@rat-stack/job-store/d1";
import { Stage } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as RuntimeContext from "alchemy/RuntimeContext";
import * as Stripe from "alchemy/Stripe";
import {
  Clock,
  Config,
  Effect,
  Layer,
  Option,
  Record,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpRouter, HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { mcpAppLayer, serveMcp, serveMcpDiscovery } from "./mcp.js";
import { guardPreviewAccess } from "./preview-access.js";
import { handleRoutes } from "./route.js";
import { stageConfig } from "./stage-config.js";
import { stripeBilling } from "./stripe.js";

export const rpcProjection = toRpc(capabilities);

export const INGEST_SCHEDULE = `*/${INGEST_INTERVAL_MINUTES} * * * *`;

export const DEFAULT_FEED_CONCURRENCY = 6;

export const ENRICHMENT_BATCH_SIZE = 10;

export const ENRICHMENT_MAX_RETRIES = 3;

export const DEFAULT_ENRICHMENT_SWEEP_HOURS = 24;

export const EnrichmentQueue = Cloudflare.Queues.Queue("EnrichmentQueue");

const EnrichmentMessage = Schema.Struct({ id: Schema.NonEmptyString });

const enrichMessage =
  (dailyNeurons: number) => (message: Cloudflare.Queues.Message) =>
    Option.match(Schema.decodeUnknownOption(EnrichmentMessage)(message.body), {
      onNone: () =>
        Effect.logWarning(
          `enrichment message dropped: no listing id, body=${loggedBody(JSON.stringify(message.body ?? null))}`
        ),
      onSome: ({ id }) =>
        enrichListing(id, dailyNeurons).pipe(
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

export const MAGIC_LINK_SENDER = `sign-in@${SITE_HOSTNAME}`;

export const DIGEST_SENDER = `digest@${SITE_HOSTNAME}`;

export const DIGEST_SCHEDULE = "7 * * * *";

export {
  DEFAULT_DIGEST_DAILY_SEND_LIMIT,
  DEFAULT_DIGEST_SENDS_PER_RUN,
} from "./stage-config.js";

export const INSTANT_ALERT_SCHEDULE = "10,30,50 * * * *";

const currentStage = Effect.gen(function* currentStage() {
  const planned = yield* Effect.serviceOption(Stage);

  return Option.isSome(planned)
    ? planned.value
    : yield* Config.String("ALCHEMY_STAGE");
});

const backendDatabase = Effect.gen(function* backendDatabase() {
  return isPullRequestStage(yield* currentStage)
    ? yield* Cloudflare.D1.Database.ref("JobsDatabase", { stage: "preview" })
    : yield* JobsDatabase;
});

const localAuthHosts = Config.String("AUTH_EXTRA_HOSTS").pipe(
  Config.withDefault(""),
  Config.map((hosts) =>
    hosts
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host !== "")
  )
);

const restrictedStripeKey = Config.option(
  Config.Redacted("STRIPE_RESTRICTED_KEY")
).pipe(Config.map(Option.filter((key) => Redacted.value(key) !== "")));

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

export default class JobsBackend extends Cloudflare.Worker<JobsBackend>()(
  "JobsBackend",
  Effect.gen(function* backendProps() {
    const stage = yield* currentStage;

    return {
      main: import.meta.url,
      observability: { enabled: true },
      ...(isPullRequestStage(stage)
        ? {
            preview: {
              name: stage,
              of: yield* Cloudflare.Worker.ref("PullRequestBackend", {
                stage: "preview",
              }),
            },
          }
        : { workersDev: false }),
    };
  }),
  Effect.gen(function* jobsBackend() {
    const stage = yield* currentStage;
    const configuration = yield* stageConfig(stage);
    const pullRequest = isPullRequestStage(stage);
    const database = yield* backendDatabase;
    const client = yield* Cloudflare.D1.QueryDatabase(database);
    const storeLayer = d1JobStoreLayer(client);
    const alertLayer = d1AlertStoreLayer(client);

    const feedsPerRun = yield* Config.Int("INGEST_FEEDS_PER_RUN").pipe(
      Config.withDefault(DEFAULT_FEEDS_PER_RUN)
    );

    const feedConcurrency = yield* Config.Int("INGEST_FEED_CONCURRENCY").pipe(
      Config.withDefault(DEFAULT_FEED_CONCURRENCY)
    );

    const stageOutput: Output.Output<string | undefined> = Output.literal(
      Option.getOrElse(yield* Effect.serviceOption(Stage), () => "")
    );

    const deployedStage =
      (yield* yield* stageOutput.bind("ENRICHMENT_STAGE")) ?? "";

    const sweepLimit = pullRequest
      ? 0
      : sweepLimitOf({
          configured: yield* Config.option(
            Config.Int("ENRICHMENT_SWEEP_LIMIT")
          ),
          stage: deployedStage,
        });

    const { dailyNeurons } = configuration;

    const sweepHours = yield* Config.Int("ENRICHMENT_SWEEP_HOURS").pipe(
      Config.withDefault(DEFAULT_ENRICHMENT_SWEEP_HOURS)
    );

    const queue = pullRequest
      ? yield* Cloudflare.Queues.Queue.ref("EnrichmentQueue", {
          stage: "preview",
        })
      : yield* EnrichmentQueue;

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

    const feedsLayer = postingFeedsLayer().pipe(
      Layer.provide(FetchHttpClient.layer)
    );

    const ingestLayer = Layer.mergeAll(storeLayer, queueLayer, feedsLayer);

    const enrichmentLayer = Layer.mergeAll(
      storeLayer,
      enricherLayer,
      postingTextsLayer.pipe(Layer.provide(FetchHttpClient.layer))
    );

    if (!pullRequest) {
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
                Effect.logInfo(
                  `listings queued for enrichment queued=${queued} limit=${sweepLimit} stage=${deployedStage}`
                )
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
            Stream.mapEffect(enrichMessage(dailyNeurons), {
              concurrency: ENRICHMENT_BATCH_SIZE,
              unordered: true,
            }),
            Stream.runDrain,
            Effect.provide(enrichmentLayer)
          )
      );
    }

    const secret = yield* authSecret;

    const social = Record.getSomes({
      github: yield* socialCredentials("GITHUB"),
      google: yield* socialCredentials("GOOGLE"),
    });

    const { subdomain } = configuration;

    const hosts = siteHostsOf(stage, {
      localHosts: yield* localAuthHosts,
      workersSubdomain: subdomain,
    });

    const { billingEnabled } = configuration;

    const stripe = yield* stripeBilling({
      hostId: "JobsBackend",
      restrictedKey: billingEnabled
        ? yield* restrictedStripeKey
        : Option.none(),
      siteOrigin: billingEnabled
        ? publicOriginOf(stage, subdomain)
        : Option.none(),
      stage,
    });

    const billingLayer = Layer.mergeAll(
      d1BillingStoreLayer(client),
      Layer.succeed(Billing, stripe.billing)
    );

    const mailer = yield* Cloudflare.Email.Send(
      yield* Cloudflare.Email.SendEmail("MagicLinkEmail", {
        allowedSenderAddresses: [MAGIC_LINK_SENDER, DIGEST_SENDER],
      })
    );

    const { digestSiteOrigin } = configuration;

    const digestPlan = {
      dailySendLimit: configuration.digestDailySendLimit,
      sendsPerRun: configuration.digestSendsPerRun,
    };

    const unsubscribeTokenVersion = yield* Config.Int(
      "UNSUBSCRIBE_TOKEN_VERSION"
    ).pipe(Config.withDefault(1), Config.map(String));

    const digestMailer = makeDigestMailer({
      secret,
      send: (email) =>
        mailer
          .send(email)
          .pipe(Effect.provide(RuntimeContext.RuntimeContext.phantom)),
      sender: DIGEST_SENDER,
      siteOrigin: digestSiteOrigin,
      unsubscribeTokenVersion,
    });

    if (!pullRequest) {
      yield* Cloudflare.Workers.cron(DIGEST_SCHEDULE, (controller) =>
        runDigests(digestPlan, controller.scheduledTime).pipe(
          Effect.tap((receipt) => Effect.logInfo("digests finished", receipt)),
          Effect.tapError((error) => Effect.logError("digests failed", error)),
          Effect.annotateLogs({
            cron: controller.cron,
            scheduledTime: controller.scheduledTime,
          }),
          Effect.provide(
            Layer.mergeAll(
              alertLayer,
              Layer.succeed(DigestMailer, digestMailer)
            )
          )
        )
      );

      yield* Cloudflare.Workers.cron(INSTANT_ALERT_SCHEDULE, (controller) =>
        runInstantAlerts(digestPlan, controller.scheduledTime).pipe(
          Effect.tap((receipt) =>
            Effect.logInfo("instant alerts finished", receipt)
          ),
          Effect.tapError((error) =>
            Effect.logError("instant alerts failed", error)
          ),
          Effect.annotateLogs({
            cron: controller.cron,
            scheduledTime: controller.scheduledTime,
          }),
          Effect.provide(
            Layer.mergeAll(
              alertLayer,
              Layer.succeed(DigestMailer, digestMailer)
            )
          )
        )
      );
    }

    const runPromise = Effect.runPromiseWith(yield* Effect.context());

    const { magicLinkDailySendLimit } = configuration;

    const auth = yield* BetterAuth({
      ...authOptions({
        hosts,
        magicLinkDailySendLimit,
        // @effect-diagnostics-next-line asyncFunction:off -- better-auth awaits a Promise-returning sender.
        sendMagicLink: async (request) => {
          await runPromise(
            mailer
              .send(magicLinkEmail(MAGIC_LINK_SENDER, request))
              .pipe(
                Effect.tapError(logSendFailure),
                Effect.provide(RuntimeContext.RuntimeContext.phantom)
              )
          );
        },
        social,
      }),
      migrate: false,
      secret,
    });

    const accountStore = makeAccountStore(
      (headers) =>
        auth.api
          .getSession({ headers, query: { disableRefresh: true } })
          .pipe(Effect.provide(RuntimeContext.RuntimeContext.phantom)),
      {
        socialProviders: SocialProvider.literals.filter(
          (provider) => social[provider] !== undefined
        ),
      }
    );

    const mcpHttp = yield* HttpRouter.toHttpEffect(
      mcpAppLayer(
        Layer.mergeAll(storeLayer, feedsLayer, alertLayer, billingLayer)
      )
    ).pipe(Effect.orDie);

    const agentAccessLayer = Layer.mergeAll(
      d1AgentTokenStoreLayer(client),
      billingLayer
    );

    const mcp = (request: HttpServerRequest.HttpServerRequest) =>
      serveMcp(mcpHttp)(request).pipe(Effect.provide(agentAccessLayer));

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
                  feedsLayer,
                  alertLayer,
                  agentAccessLayer,
                  Layer.succeed(AccountStore, accountStore),
                  Layer.succeed(CurrentViewer, viewer)
                )
              )
            )
          )
        )
      );

    const unsubscribe = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* unsubscribeHandler() {
        const token =
          new URL(request.url, SITE_ORIGIN).searchParams.get("token") ?? "";

        const account = yield* verifyUnsubscribeToken(
          secret,
          token,
          unsubscribeTokenVersion
        );

        if (Option.isNone(account)) {
          return unsubscribePage("Invalid", token);
        }

        if (request.method !== "POST") {
          return unsubscribePage("Confirm", token);
        }

        const now = yield* Clock.currentTimeMillis;

        return yield* AlertStore.use((store) =>
          store.unsubscribe(account.value, now)
        ).pipe(
          Effect.provide(alertLayer),
          Effect.as(unsubscribePage("Done", token)),
          Effect.catchTag("JobStoreUnavailable", (failure) =>
            Effect.logWarning("unsubscribe failed", failure).pipe(
              Effect.as(unsubscribePage("Unavailable", token))
            )
          )
        );
      }).pipe(
        Effect.map((page) =>
          HttpServerResponse.text(page.html, {
            contentType: "text/html; charset=utf-8",
            headers: {
              "cache-control": "private, no-store",
              "content-security-policy":
                "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
              "referrer-policy": "no-referrer",
            },
            status: page.status,
          })
        )
      );

    const stripeWebhook = (request: HttpServerRequest.HttpServerRequest) =>
      stripe.endpoint.pipe(
        Effect.flatMap((endpoint) => stripeWebhookResponse(endpoint, request)),
        Effect.provide(billingLayer)
      );

    const handle = handleRoutes({
      accountStore,
      auth: auth.fetch,
      mcp,
      mcpDiscovery: serveMcpDiscovery,
      rpc: serveRpc,
      stripeWebhook,
      unsubscribe,
    });

    return {
      fetch: Effect.succeed(
        pullRequest
          ? guardPreviewAccess({
              handle,
              publicOrigin: Option.getOrThrow(publicOriginOf(stage, subdomain)),
              secret: yield* Config.Redacted("PR_PREVIEW_SECRET"),
              stage,
            })
          : handle
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        RuntimeContext.RuntimeContext.phantom,
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Workers.CronEventSourceLive,
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Queues.EventSourceLive,
        Cloudflare.Workers.AIBinding,
        Cloudflare.Email.SendBinding,
        CloudflareD1(backendDatabase.pipe(Effect.orDie)),
        Stripe.CreateCheckoutSessionHttp,
        Stripe.CreateCustomerHttp,
        Stripe.CreateBillingPortalSessionHttp
      )
    )
  )
) {}
