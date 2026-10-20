import { isAuthPath, respondAsViewer } from "@rat-stack/accounts";
import { STRIPE_WEBHOOK_PATH } from "@rat-stack/billing";
import { MCP_DISCOVERY_PATH, MCP_PATH, SITE_ORIGIN } from "@rat-stack/core";
import type { AccountStore, ViewerValue } from "@rat-stack/core";
import { UNSUBSCRIBE_PATH } from "@rat-stack/digest-mailer";
import { Effect } from "effect";
import type { HttpServerResponse } from "effect/http";
import { HttpServerRequest } from "effect/http";

const pathOf = (url: string) => new URL(url, SITE_ORIGIN).pathname;

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

    if (isAuthPath(request.url)) {
      return yield* routes.auth;
    }

    const path = pathOf(request.url);

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

    return yield* respondAsViewer(
      routes.accountStore,
      request.headers,
      routes.rpc
    );
  });
