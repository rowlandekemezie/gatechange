import { isAuthPath, respondAsViewer } from "@rat-stack/accounts";
import { SITE_ORIGIN } from "@rat-stack/core";
import type { AccountStore, ViewerValue } from "@rat-stack/core";
import { UNSUBSCRIBE_PATH } from "@rat-stack/digest-mailer";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http";
import type { HttpServerResponse } from "effect/http";

const pathOf = (url: string) => new URL(url, SITE_ORIGIN).pathname;

export interface Routes<Error, Context> {
  readonly accountStore: AccountStore["Service"];
  readonly auth: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    Error,
    Context
  >;
  readonly rpc: (
    viewer: ViewerValue
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

    if (pathOf(request.url) === UNSUBSCRIBE_PATH) {
      return yield* routes.unsubscribe(request);
    }

    return yield* respondAsViewer(
      routes.accountStore,
      request.headers,
      routes.rpc
    );
  });
