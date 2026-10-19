import { toToolkit } from "@rat-stack/capability/toolkit";
import {
  agentCapabilities,
  agentSources,
  AgentTokenStore,
  bearerSecretOf,
  CurrentViewer,
  entitlementOfAccount,
  isPro,
  MCP_PATH,
  secretHashOf,
  ServedSources,
  Viewer,
} from "@rat-stack/core";
import type {
  AlertStore,
  BillingStore,
  JobStore,
  JobStoreUnavailable,
  TrackerStore,
} from "@rat-stack/core";
import { Data, Effect, Layer, Match, Option } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http";

export const MCP_SERVER_NAME = "jobs-rowlandekemezie";

export const MCP_SERVER_VERSION = "1.0.0";

const MCP_PROTOCOLS = [McpProtocol.v2026_07_28] as const;

const INSTRUCTIONS =
  "Search engineering leadership roles (managers to CTOs) posted in the last 30 days with listJobs, and read board health with boardStats. Every listing links to its original posting; send applicants there. Pro members connect with a personal token from their account page to save searches and keep an application tracker.";

export const agentToolkit = toToolkit(agentCapabilities);

type AgentStores = AlertStore | BillingStore | JobStore | TrackerStore;

export const mcpAppLayer = <E, R>(stores: Layer.Layer<AgentStores, E, R>) =>
  McpServer.toolkit(agentToolkit.toolkit).pipe(
    Layer.provide(
      agentToolkit.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            stores,
            Layer.succeed(CurrentViewer, Viewer.Anonymous()),
            Layer.succeed(ServedSources, agentSources())
          )
        )
      )
    ),
    Layer.provideMerge(
      McpServer.layerHttp({
        allowedOrigins: [],
        instructions: INSTRUCTIONS,
        name: MCP_SERVER_NAME,
        path: MCP_PATH,
        protocols: MCP_PROTOCOLS,
        version: MCP_SERVER_VERSION,
      })
    )
  );

export class AgentTokenRefused extends Data.TaggedError("AgentTokenRefused")<{
  readonly message: string;
  readonly status: 401 | 403;
}> {}

export const agentViewerOf = Effect.fn("agentViewerOf")(function* agentViewerOf(
  authorization: string | undefined
) {
  const secret = bearerSecretOf(authorization);

  if (Option.isNone(secret)) {
    return Viewer.Anonymous();
  }

  const hash = yield* secretHashOf(secret.value);
  const holder = yield* AgentTokenStore.use((store) => store.holderOf(hash));

  if (Option.isNone(holder)) {
    return yield* new AgentTokenRefused({
      message:
        "This agent token is unknown or revoked. Issue a new one on your account page, or drop the Authorization header to use the free tools.",
      status: 401,
    });
  }

  if (!isPro(yield* entitlementOfAccount(holder.value.id))) {
    return yield* new AgentTokenRefused({
      message:
        "Pro has ended for this token's account. Renew Pro to use the Pro tools, or drop the Authorization header to use the free tools.",
      status: 403,
    });
  }

  return Viewer.Member({ account: holder.value });
});

const jsonRpcError = (status: number, message: string, headers = {}) =>
  HttpServerResponse.jsonUnsafe(
    { error: { code: -32_001, message }, id: null, jsonrpc: "2.0" },
    { headers: { "cache-control": "private, no-store", ...headers }, status }
  );

const refusalOf = (failure: AgentTokenRefused | JobStoreUnavailable) =>
  Match.valueTags(failure, {
    AgentTokenRefused: ({ message, status }) =>
      jsonRpcError(
        status,
        message,
        status === 401
          ? { "www-authenticate": 'Bearer error="invalid_token"' }
          : {}
      ),
    JobStoreUnavailable: () =>
      jsonRpcError(
        503,
        "The job board is briefly unavailable. Retry in a minute.",
        { "retry-after": "60" }
      ),
  });

export const serveMcp =
  <E, R>(mcpHttp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  (request: HttpServerRequest.HttpServerRequest) =>
    agentViewerOf(request.headers.authorization).pipe(
      Effect.matchEffect({
        onFailure: (failure) => Effect.succeed(refusalOf(failure)),
        onSuccess: (viewer) =>
          mcpHttp.pipe(
            Effect.provideService(CurrentViewer, viewer),
            Effect.scoped
          ),
      })
    );
