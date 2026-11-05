import { Account } from "@rat-stack/core/contracts";
import type { SocialProviderValue } from "@rat-stack/core/contracts";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { LinkPreview } from "./model.js";
import type { LinkOutcomeValue, LinkPreviewValue } from "./model.js";

const AUTH_PATH = "/api/auth";

const RETURN_PATH = "/account";

const NamedLink = Schema.Struct({ email: Schema.String });

const REFUSED_STATUS = 404;

const SocialRedirect = Schema.Struct({ url: Schema.String });

const CurrentSession = Schema.NullOr(Schema.Struct({ user: Account }));

type AuthRequestBody = Readonly<Record<string, string>>;

const linkOutcomeOf = (status: number): LinkOutcomeValue => {
  if (status === 200) {
    return "Sent";
  }

  if (status === 400) {
    return "Invalid";
  }

  return status === 429 ? "Limited" : "Failed";
};

const make = Effect.gen(function* makeAuthClient() {
  const http = yield* HttpClient.HttpClient;

  const post = (path: string, body: AuthRequestBody) =>
    http.execute(
      HttpClientRequest.post(`${AUTH_PATH}${path}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body)
      )
    );

  return {
    currentAccount: http.get(`${AUTH_PATH}/get-session`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(CurrentSession)),
      Effect.map((session) =>
        Option.map(Option.fromNullishOr(session), ({ user }) => user)
      )
    ),
    previewLink: (token: string) =>
      http
        .get(`${AUTH_PATH}/magic-link/preview`, { urlParams: { token } })
        .pipe(
          Effect.flatMap(
            (response): Effect.Effect<LinkPreviewValue, unknown> =>
              response.status === REFUSED_STATUS
                ? Effect.succeed(LinkPreview.Refused())
                : HttpClientResponse.filterStatusOk(response).pipe(
                    Effect.flatMap(
                      HttpClientResponse.schemaBodyJson(NamedLink)
                    ),
                    Effect.map(LinkPreview.Named)
                  )
          ),
          Effect.orElseSucceed(() => LinkPreview.Unknown())
        ),
    requestLink: (email: string) =>
      post("/sign-in/magic-link", {
        callbackURL: RETURN_PATH,
        email,
        errorCallbackURL: RETURN_PATH,
      }).pipe(
        Effect.map(({ status }) => linkOutcomeOf(status)),
        Effect.orElseSucceed((): LinkOutcomeValue => "Failed")
      ),
    signOut: post("/sign-out", {}).pipe(Effect.asVoid),
    socialRedirect: (provider: SocialProviderValue) =>
      post("/sign-in/social", {
        callbackURL: RETURN_PATH,
        errorCallbackURL: RETURN_PATH,
        provider,
      }).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(SocialRedirect)),
        Effect.map(({ url }) => url)
      ),
  };
});

export class AuthClient extends Context.Service<
  AuthClient,
  Effect.Success<typeof make>
>()("@rat-stack/web/AuthClient", { make }) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(FetchHttpClient.layer)
  );
}
