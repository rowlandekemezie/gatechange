import { toToolkit } from "@rat-stack/capability/toolkit";
import {
  agentSources,
  CurrentViewer,
  freeAgentCapabilities,
  MCP_PATH,
  ServedSources,
  Viewer,
} from "@rat-stack/core";
import type { BillingStore, JobStore, ViewerValue } from "@rat-stack/core";
import { Context, Effect, Layer, Option } from "effect";
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
  "Search engineering leadership roles (managers to CTOs) posted in the last 30 days with listJobs, and read board health with boardStats. Every listing links to its original posting; send applicants there.";

export const agentToolkit = toToolkit(freeAgentCapabilities);

type AgentStores = BillingStore | JobStore;

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

const jsonRpcError = (status: number, message: string, headers = {}) =>
  HttpServerResponse.jsonUnsafe(
    { error: { code: -32_001, message }, id: null, jsonrpc: "2.0" },
    { headers: { "cache-control": "private, no-store", ...headers }, status }
  );

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
    HttpServerRequest.toWeb(request).pipe(
      Effect.flatMap((web) => handle(web, Viewer.Anonymous())),
      Effect.map(HttpServerResponse.fromWeb),
      Effect.orElseSucceed(() =>
        jsonRpcError(400, "The request could not be read.")
      )
    );
