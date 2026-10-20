import { Effect, Result, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

export const MCP_WIRE_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;

const JsonMessage = Schema.fromJsonString(Schema.Json);

const RequestMessage = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.String,
  params: Schema.optional(Schema.JsonObject),
});

const Initialize = Schema.Struct({
  capabilities: Schema.JsonObject,
  clientInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
  protocolVersion: Schema.String,
});

const ToolCall = Schema.Struct({ name: Schema.String });

const Metadata = Schema.Struct({
  "io.modelcontextprotocol/protocolVersion": Schema.optional(Schema.String),
});

const rpcError = (
  id: string | number | undefined,
  code: number,
  message: string,
  status = 400
) =>
  HttpServerResponse.jsonUnsafe(
    { error: { code, message }, id: id ?? null, jsonrpc: "2.0" },
    { headers: { "cache-control": "private, no-store" }, status }
  );

const mediaTypes = (header = "") =>
  header.split(",").flatMap((part) => {
    const [media = "", ...parameters] = part.trim().toLowerCase().split(";");
    const quality = parameters.find((value) => value.trim().startsWith("q="));

    if (quality !== undefined) {
      const value = Number(quality.trim().slice(2));

      if (!Number.isFinite(value) || value <= 0 || value > 1) {
        return [];
      }
    }

    return [media.trim()];
  });

const transportRefusal = (
  request: HttpServerRequest.HttpServerRequest,
  version: string | undefined
) => {
  if (request.headers.origin !== undefined) {
    return HttpServerResponse.empty({ status: 403 });
  }

  if (mediaTypes(request.headers["content-type"])[0] !== "application/json") {
    return HttpServerResponse.empty({ status: 415 });
  }

  const accepted = mediaTypes(request.headers.accept);

  if (
    !accepted.includes("application/json") ||
    !accepted.includes("text/event-stream")
  ) {
    return HttpServerResponse.empty({ status: 406 });
  }

  if (
    version !== undefined &&
    !MCP_WIRE_VERSIONS.some((wire) => wire === version)
  ) {
    return rpcError(undefined, -32_000, "Unsupported MCP protocol version");
  }

  if (request.headers["mcp-session-id"] !== undefined) {
    return rpcError(
      undefined,
      -32_000,
      "This server does not use MCP sessions"
    );
  }

  return null;
};

const lifecycleResponse = (
  message: typeof RequestMessage.Type,
  version: string | undefined,
  serverInfo: { readonly name: string; readonly version: string },
  instructions: string
) => {
  const { id, method } = message;
  const params = message.params ?? {};

  if (method === "initialize") {
    const initialize = Schema.decodeUnknownResult(Initialize)(params);

    if (id === undefined || Result.isFailure(initialize)) {
      return rpcError(id, -32_602, "Invalid initialize parameters");
    }

    const offered = initialize.success.protocolVersion;

    if (version !== undefined && version !== offered) {
      return rpcError(
        id,
        -32_602,
        "MCP-Protocol-Version header does not match initialize"
      );
    }

    const negotiated =
      MCP_WIRE_VERSIONS.find(
        (wire) => wire !== "2026-07-28" && wire === offered
      ) ?? "2025-11-25";

    return HttpServerResponse.jsonUnsafe(
      {
        id,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          instructions,
          protocolVersion: negotiated,
          serverInfo,
        },
      },
      { headers: { "cache-control": "private, no-store" } }
    );
  }

  if (method === "notifications/initialized" && id === undefined) {
    return HttpServerResponse.empty({ status: 202 });
  }

  if (id === undefined) {
    return rpcError(id, -32_600, "Expected a JSON-RPC request id");
  }

  if (method === "ping") {
    return HttpServerResponse.jsonUnsafe({ id, jsonrpc: "2.0", result: {} });
  }

  if (method !== "tools/list" && method !== "tools/call") {
    return rpcError(id, -32_601, "Method not found", 404);
  }

  return null;
};

const toolHeaders = (
  originalHeaders: Readonly<Record<string, string>>,
  message: typeof RequestMessage.Type
) => {
  const { id, method } = message;
  const params = message.params ?? {};

  const headers = new Headers(originalHeaders);
  headers.set("mcp-protocol-version", "2026-07-28");
  headers.set("mcp-method", method);
  const nameHeader = headers.get("mcp-name");

  if (method === "tools/call") {
    const call = Schema.decodeUnknownResult(ToolCall)(params);

    if (Result.isFailure(call)) {
      return Result.fail(rpcError(id, -32_602, "Expected a tool name"));
    }

    const encoded = Result.try(() => encodeURIComponent(call.success.name));

    if (Result.isFailure(encoded)) {
      return Result.fail(rpcError(id, -32_602, "Invalid tool name"));
    }

    const encodedName = encoded.success;

    if (nameHeader !== null && nameHeader !== encodedName) {
      return Result.fail(
        rpcError(id, -32_602, "MCP-Name header does not match tool name")
      );
    }

    headers.set("mcp-name", encodedName);
  } else if (nameHeader !== null) {
    return Result.fail(
      rpcError(id, -32_602, "MCP-Name header is only valid for tools/call")
    );
  }

  return Result.succeed(headers);
};

export const withStreamableHttpCompatibility = <E, R>(
  mcpHttp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  serverInfo: { readonly name: string; readonly version: string },
  instructions: string
) =>
  Effect.gen(function* streamableHttp() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const version = request.headers["mcp-protocol-version"];

    if (request.method !== "POST" || version === "2026-07-28") {
      return yield* mcpHttp;
    }

    const invalidTransport = transportRefusal(request, version);

    if (invalidTransport !== null) {
      return invalidTransport;
    }

    const body = yield* Effect.result(request.text);

    if (Result.isFailure(body)) {
      return rpcError(undefined, -32_700, "Could not read JSON request");
    }

    const json = Schema.decodeResult(JsonMessage)(body.success);

    if (Result.isFailure(json)) {
      return rpcError(undefined, -32_700, "Invalid JSON");
    }

    const decoded = Schema.decodeUnknownResult(RequestMessage)(json.success);

    if (Result.isFailure(decoded)) {
      return rpcError(undefined, -32_600, "Invalid JSON-RPC request");
    }

    const message = decoded.success;
    const { id, method } = message;
    const params = message.params ?? {};
    const methodHeader = request.headers["mcp-method"];

    if (methodHeader !== undefined && methodHeader !== method) {
      return rpcError(
        id,
        -32_602,
        "MCP-Method header does not match request method"
      );
    }

    const metadata = Schema.decodeUnknownResult(Metadata)(
      params._meta === undefined ? {} : params._meta
    );

    if (Result.isFailure(metadata)) {
      return rpcError(id, -32_602, "Invalid request metadata");
    }

    const claim = metadata.success["io.modelcontextprotocol/protocolVersion"];

    if (claim !== undefined && claim !== (version ?? "2025-03-26")) {
      return rpcError(
        id,
        -32_602,
        "MCP-Protocol-Version header does not match request metadata"
      );
    }

    const lifecycle = lifecycleResponse(
      message,
      version,
      serverInfo,
      instructions
    );

    if (lifecycle !== null) {
      return lifecycle;
    }

    const routed = toolHeaders(request.headers, message);

    if (Result.isFailure(routed)) {
      return routed.failure;
    }

    const headers = routed.success;

    headers.delete("content-length");

    const translated = HttpServerRequest.fromWeb(
      new Request(new URL(request.url, "http://localhost"), {
        body: JSON.stringify({
          ...message,
          params: {
            ...params,
            _meta: {
              ...metadata.success,
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
          },
        }),
        headers,
        method: "POST",
      })
    );

    return yield* mcpHttp.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, translated)
    );
  });
