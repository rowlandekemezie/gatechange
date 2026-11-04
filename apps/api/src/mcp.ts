import { toToolkit } from "@rat-stack/capability/toolkit";
import {
  agentCapabilities,
  agentSources,
  AgentTokenStore,
  ANONYMOUS_MCP_CALLS_PER_MINUTE,
  bearerSecretOf,
  CurrentViewer,
  entitlementOfAccount,
  freeAgentCapabilities,
  isPro,
  MCP_PATH,
  secretHashOf,
  ServedSources,
  TOKEN_MCP_CALLS_PER_MINUTE,
  Viewer,
} from "@rat-stack/core";
import type {
  AlertStore,
  BillingStore,
  JobStore,
  JobStoreUnavailable,
  PostingFeeds,
  TrackerStore,
} from "@rat-stack/core";
import { Data, Effect, Layer, Match, Option } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http";

import {
  MCP_WIRE_VERSIONS,
  withStreamableHttpCompatibility,
} from "./mcp-streamable-http.js";

export const MCP_SERVER_NAME = "gate-change";

export const MCP_SERVER_VERSION = "1.0.0";

const MCP_PROTOCOLS = [McpProtocol.v2026_07_28] as const;

const INSTRUCTIONS =
  "Search open engineering leadership roles (managers to CTOs) with listJobs, and read board health with boardStats. Every listing links to its original posting; send applicants there. Pro members connect with a personal token from their account page to save searches and keep an application tracker.";

export const agentToolkit = toToolkit(agentCapabilities);

const freeToolNames: ReadonlySet<string> = new Set(
  freeAgentCapabilities.map(({ contract }) => contract.name)
);

type AgentStores =
  | AlertStore
  | BillingStore
  | JobStore
  | TrackerStore
  | PostingFeeds;

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
          withStreamableHttpCompatibility(
            mcpHttp,
            { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
            INSTRUCTIONS
          ).pipe(Effect.provideService(CurrentViewer, viewer), Effect.scoped),
      })
    );

export const mcpDiscovery = (origin: string) => ({
  authentication: {
    description:
      "Free tools need no token. Pro tools need a personal token from the account page, sent as Authorization: Bearer <token> on every request.",
    required: false,
    scheme: "bearer",
    tokens: `${origin}/account`,
  },
  description:
    "Engineering leadership roles from company boards and job aggregators, refreshed every 20 minutes. Listings from sources whose terms forbid redistribution are left out.",
  endpoint: `${origin}${MCP_PATH}`,
  name: MCP_SERVER_NAME,
  protocolVersions: MCP_WIRE_VERSIONS,
  rateLimits: {
    anonymousCallsPerMinute: ANONYMOUS_MCP_CALLS_PER_MINUTE,
    tokenCallsPerMinute: TOKEN_MCP_CALLS_PER_MINUTE,
  },
  tools: agentCapabilities.map(({ contract }) => ({
    access: freeToolNames.has(contract.name) ? "free" : "pro",
    description: contract.description,
    name: contract.name,
  })),
  transport: "streamable-http",
  version: MCP_SERVER_VERSION,
});

export const serveMcpDiscovery = (
  request: HttpServerRequest.HttpServerRequest
) =>
  HttpServerResponse.jsonUnsafe(
    mcpDiscovery(new URL(request.originalUrl).origin),
    { headers: { "access-control-allow-origin": "*" } }
  );
