import { isAuthPath, respondAsViewer } from "@rat-stack/accounts";
import { STRIPE_WEBHOOK_PATH } from "@rat-stack/billing";
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  MCP_DISCOVERY_PATH,
  MCP_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
  SITE_ORIGIN,
} from "@rat-stack/core";
import type { AccountStore, ViewerValue } from "@rat-stack/core";
import { UNSUBSCRIBE_PATH } from "@rat-stack/digest-mailer";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

const pathOf = (url: string) => new URL(url, SITE_ORIGIN).pathname;

const RPC_PATH = "/rpc";

const BATCHED_RPC = /^\s*\[/u;

const protectedResourcePaths: ReadonlySet<string> = new Set([
  PROTECTED_RESOURCE_METADATA_PATH,
  `${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`,
]);

export interface Routes<Error, Context> {
  readonly accountStore: AccountStore["Service"];
  readonly auth: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    Error,
    Context
  >;
  readonly mcp: (
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, Error, Context>;
  readonly mcpDiscovery: (
    request: HttpServerRequest.HttpServerRequest
  ) => HttpServerResponse.HttpServerResponse;
  readonly protectedResourceMetadata: (
    request: HttpServerRequest.HttpServerRequest
  ) => HttpServerResponse.HttpServerResponse;
  readonly rpc: (
    viewer: ViewerValue
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, Error, Context>;
  readonly stripeWebhook: (
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, Error, Context>;
  readonly unsubscribe: (
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, Error, Context>;
}

export const handleRoutes = <Error, Context>(routes: Routes<Error, Context>) =>
  Effect.gen(function* handle() {
    const request = yield* HttpServerRequest.HttpServerRequest;

    const path = pathOf(request.url);

    if (
      isAuthPath(request.url) ||
      path.startsWith(`${AUTHORIZATION_SERVER_METADATA_PATH}/`)
    ) {
      return yield* routes.auth;
    }

    if (protectedResourcePaths.has(path)) {
      return routes.protectedResourceMetadata(request);
    }

    if (path === MCP_PATH) {
      return yield* routes.mcp(request);
    }

    if (path === MCP_DISCOVERY_PATH) {
      return routes.mcpDiscovery(request);
    }

    if (path === UNSUBSCRIBE_PATH) {
      return yield* routes.unsubscribe(request);
    }

    if (path === STRIPE_WEBHOOK_PATH) {
      return yield* routes.stripeWebhook(request);
    }

    if (path !== RPC_PATH && !path.startsWith(`${RPC_PATH}/`)) {
      return HttpServerResponse.empty({ status: 404 });
    }

    const body = yield* Effect.orElseSucceed(request.text, () => "");

    if (BATCHED_RPC.test(body)) {
      return HttpServerResponse.text("Send one call per request.", {
        status: 400,
      });
    }

    return yield* respondAsViewer(
      routes.accountStore,
      request.headers,
      routes.rpc
    );
  });
