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
  ViewerValue,
} from "@rat-stack/core";
import { Context, Data, Effect, Layer, Match, Option } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

export const MCP_SERVER_NAME = "jobs-rowlandekemezie";

export const MCP_SERVER_VERSION = "1.0.0";

const MCP_PROTOCOLS = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
] as const;

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

const SESSION_HEADER = "mcp-session-id";

const PROTOCOL_HEADER = "mcp-protocol-version";

const MAX_RECOVERED_SESSIONS = 1000;

export type McpWebHandler = (
  request: Request,
  context: Context.Context<never>
) => Promise<Response>;

type SessionHeader = { readonly drop: true } | { readonly id: string };

const relayed = (
  request: Request,
  body: string,
  session: SessionHeader | undefined
) => {
  const headers = new Headers(request.headers);

  if (session !== undefined && "drop" in session) {
    headers.delete(SESSION_HEADER);
    headers.delete(PROTOCOL_HEADER);
  }

  if (session !== undefined && "id" in session) {
    headers.set(SESSION_HEADER, session.id);
  }

  return new Request(request.url, { body, headers, method: request.method });
};

export const recoveringSessions = (handle: McpWebHandler) => {
  const recovered = new Map<string, string>();

  const send = (
    request: Request,
    body: string,
    viewer: ViewerValue,
    session?: SessionHeader
  ) =>
    Effect.promise(
      // @effect-diagnostics-next-line asyncFunction:off -- The web handler is Promise-based.
      async () =>
        await handle(
          relayed(request, body, session),
          Context.make(CurrentViewer, viewer)
        )
    );

  const reopen = (request: Request, viewer: ViewerValue) =>
    Effect.gen(function* reopenSession() {
      const opened = yield* send(
        request,
        JSON.stringify({
          id: 0,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
            protocolVersion:
              request.headers.get(PROTOCOL_HEADER) ??
              McpProtocol.v2025_03_26.protocolVersion,
          },
        }),
        viewer,
        { drop: true }
      );

      const id = Option.fromNullishOr(opened.headers.get(SESSION_HEADER));

      if (Option.isSome(id)) {
        yield* send(
          request,
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
          viewer,
          { id: id.value }
        );
      }

      return id;
    });

  return (request: Request, viewer: ViewerValue) =>
    Effect.gen(function* recoveringSession() {
      const body = yield* Effect.promise(
        // @effect-diagnostics-next-line asyncFunction:off -- Request bodies are Promise-based.
        async () => await request.text()
      );

      const session = request.headers.get(SESSION_HEADER);

      if (session === null) {
        return yield* send(request, body, viewer);
      }

      const first = yield* send(request, body, viewer, {
        id: recovered.get(session) ?? session,
      });

      if (first.status !== 404) {
        return first;
      }

      const reopened = yield* reopen(request, viewer);

      if (Option.isNone(reopened)) {
        return first;
      }

      if (recovered.size >= MAX_RECOVERED_SESSIONS) {
        recovered.clear();
      }

      recovered.set(session, reopened.value);

      return yield* send(request, body, viewer, { id: reopened.value });
    });
};

export const serveMcp =
  (
    handle: (request: Request, viewer: ViewerValue) => Effect.Effect<Response>
  ) =>
  (request: HttpServerRequest.HttpServerRequest) =>
    agentViewerOf(request.headers.authorization).pipe(
      Effect.matchEffect({
        onFailure: (failure) => Effect.succeed(refusalOf(failure)),
        onSuccess: (viewer) =>
          HttpServerRequest.toWeb(request).pipe(
            Effect.flatMap((web) => handle(web, viewer)),
            Effect.map(HttpServerResponse.fromWeb),
            Effect.orElseSucceed(() =>
              jsonRpcError(400, "The request could not be read.")
            )
          ),
      })
    );
