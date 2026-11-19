import { mcpResourceOf, OAUTH_SCOPES } from "@rat-stack/accounts";
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
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAuthAccessTokens,
  PROTECTED_RESOURCE_METADATA_PATH,
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
  "Search open engineering leadership roles, from engineering managers to VPs, with listJobs, and read board health with boardStats. The board has no level above VP. A RemoteUnitedStates or RemoteCanada search also returns roles open across North America and worldwide, the same as the website. Listings from sources whose terms forbid agent access are left out, so the website can show more roles. Every listing links to its original posting; send applicants there. Pro members connect with a personal token from their account page, or by connecting an app such as ChatGPT through OAuth, to save searches and keep an application tracker.";

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

const credentials = {
  AgentToken: {
    holderOf: (secret: string, _resource: string) =>
      secretHashOf(secret).pipe(
        Effect.flatMap((hash) =>
          AgentTokenStore.use((store) => store.holderOf(hash))
        )
      ),
    unknown:
      "This agent token is unknown or revoked. Issue a new one on your account page, or drop the Authorization header to use the free tools.",
  },
  OAuth: {
    holderOf: (secret: string, resource: string) =>
      OAuthAccessTokens.use((tokens) => tokens.holderOf(secret, resource)),
    unknown:
      "This access token is unknown, expired or revoked. Reconnect your app to Gate Change, or drop the Authorization header to use the free tools.",
  },
} as const;

const credentialOf = (secret: string) =>
  credentials[
    secret.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) ? "OAuth" : "AgentToken"
  ];

export const agentViewerOf = Effect.fn("agentViewerOf")(function* agentViewerOf(
  authorization: string | undefined,
  origin: string
) {
  const secret = bearerSecretOf(authorization);

  if (Option.isNone(secret)) {
    return Viewer.Anonymous();
  }

  const credential = credentialOf(secret.value);

  const holder = yield* credential.holderOf(
    secret.value,
    mcpResourceOf(origin)
  );

  if (Option.isNone(holder)) {
    return yield* new AgentTokenRefused({
      message: credential.unknown,
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

const originOf = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.originalUrl).origin;

const refusalOf = (
  origin: string,
  failure: AgentTokenRefused | JobStoreUnavailable
) =>
  Match.valueTags(failure, {
    AgentTokenRefused: ({ message, status }) =>
      jsonRpcError(
        status,
        message,
        status === 401
          ? {
              "www-authenticate": `Bearer error="invalid_token", resource_metadata="${origin}${PROTECTED_RESOURCE_METADATA_PATH}"`,
            }
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
    agentViewerOf(request.headers.authorization, originOf(request)).pipe(
      Effect.matchEffect({
        onFailure: (failure) =>
          Effect.succeed(refusalOf(originOf(request), failure)),
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
      "Free tools need no token. Pro tools need a personal token from the account page or an OAuth 2.1 access token, sent as Authorization: Bearer <token> on every request.",
    oauth: {
      authorizationServer: `${origin}/api/auth`,
      protectedResourceMetadata: `${origin}${PROTECTED_RESOURCE_METADATA_PATH}`,
      scopes: OAUTH_SCOPES,
    },
    required: false,
    scheme: "bearer",
    tokens: `${origin}/account`,
  },
  description:
    "Engineering leadership roles from company boards and job aggregators, refreshed every 20 minutes. Listings from sources whose terms forbid agent access are left out.",
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
  HttpServerResponse.jsonUnsafe(mcpDiscovery(originOf(request)), {
    headers: { "access-control-allow-origin": "*" },
  });

export const protectedResourceMetadata = (origin: string) => ({
  authorization_servers: [`${origin}/api/auth`],
  bearer_methods_supported: ["header"],
  resource: mcpResourceOf(origin),
  resource_name: "Gate Change",
  scopes_supported: OAUTH_SCOPES,
});

export const serveProtectedResourceMetadata = (
  request: HttpServerRequest.HttpServerRequest
) =>
  HttpServerResponse.jsonUnsafe(protectedResourceMetadata(originOf(request)), {
    headers: { "access-control-allow-origin": "*" },
  });
