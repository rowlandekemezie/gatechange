import {
  Account,
  AccountStore,
  AccountStoreUnavailable,
  Viewer,
} from "@rat-stack/core";
import type {
  RequestHeaders,
  SignInOptionsValue,
  ViewerValue,
} from "@rat-stack/core";
import { Effect, Schema } from "effect";

export const SESSION_COOKIE = "better-auth.session_token";

export interface SessionUser {
  readonly email: string;
  readonly id: string;
  readonly name: string;
}

export type SessionLookup<E> = (
  headers: Headers
) => Effect.Effect<{ readonly user: SessionUser } | null, E>;

const unavailable = (message: string) =>
  new AccountStoreUnavailable({ message: message.slice(0, 500) });

const decodeAccount = Schema.decodeUnknownEffect(Account);

export const hasSessionCookie = (headers: RequestHeaders) =>
  headers.cookie?.includes(SESSION_COOKIE) === true;

const webHeadersOf = (headers: RequestHeaders) => {
  const web = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      web.set(name, value);
    }
  }

  return web;
};

export const makeAccountStore = <E>(
  lookup: SessionLookup<E>,
  signInOptions: SignInOptionsValue
) =>
  AccountStore.of({
    signInOptions,
    viewerOf: (headers) =>
      hasSessionCookie(headers)
        ? lookup(webHeadersOf(headers)).pipe(
            Effect.catchDefect(Effect.fail),
            Effect.mapError((cause) =>
              unavailable(`session lookup failed: ${String(cause)}`)
            ),
            Effect.flatMap((session) =>
              session === null
                ? Effect.succeed<ViewerValue>(Viewer.Anonymous())
                : decodeAccount({
                    email: session.user.email,
                    id: session.user.id,
                    name: session.user.name,
                  }).pipe(
                    Effect.mapError((issue) => unavailable(issue.message)),
                    Effect.map((account) => Viewer.Member({ account }))
                  )
            )
          )
        : Effect.succeed<ViewerValue>(Viewer.Anonymous()),
  });
