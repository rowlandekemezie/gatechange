// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test applies the checked-in migration SQL to a throwaway database before any Effect runs.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
} from "@rat-stack/core";
import { jobStoreMigrationDirectory } from "@rat-stack/job-store";
import { betterAuth } from "better-auth";
import { Effect, Option, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { vi } from "vitest";

import { authOptions, OAUTH_CONNECT_PATH } from "../src/index.js";
import type { MagicLinkRequest } from "../src/index.js";

const ORIGIN = "http://localhost:1337";

const RESOURCE = `${ORIGIN}/mcp`;

const T0 = Date.UTC(2026, 10, 19, 12);

const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";

const migratedDatabase = () => {
  const database = new DatabaseSync(":memory:");
  const directory = jobStoreMigrationDirectory();

  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    database.exec(readFileSync(`${directory}${file}`, "utf-8"));
  }

  return database;
};

const makeAuth = () => {
  const sent: MagicLinkRequest[] = [];
  const database = migratedDatabase();

  const auth = betterAuth({
    ...authOptions({
      hosts: {
        allowedHosts: ["localhost:*"],
        fallbackOrigin: Option.some(ORIGIN),
      },
      // @effect-diagnostics-next-line asyncFunction:off -- better-auth calls the sender as a Promise-returning callback.
      sendMagicLink: async (request) => {
        await Promise.resolve(sent.push(request));
      },
      social: {},
    }),
    database,
    secret: "test-secret-test-secret-test-secret-0",
  });

  return { auth, database, sent };
};

type Auth = ReturnType<typeof makeAuth>["auth"];

interface Call {
  readonly body?: string;
  readonly contentType?: string;
  readonly cookie?: string;
  readonly fetchSite?: string;
}

const call = (
  auth: Auth,
  path: string,
  {
    body,
    contentType = "application/json",
    cookie = "",
    fetchSite = "same-origin",
  }: Call = {}
) =>
  Effect.promise(
    // @effect-diagnostics-next-line asyncFunction:off -- better-auth's handler is Promise-based.
    async () =>
      await auth.handler(
        new Request(`${ORIGIN}${path}`, {
          body: body ?? null,
          headers: {
            "cf-connecting-ip": "203.0.113.9",
            "content-type": contentType,
            cookie,
            origin: ORIGIN,
            "sec-fetch-site": fetchSite,
          },
          method: body === undefined ? "GET" : "POST",
        })
      )
  );

const jsonOf =
  <S extends Schema.Top>(schema: S) =>
  (response: Response) =>
    Effect.promise(
      // @effect-diagnostics-next-line asyncFunction:off -- Response bodies are Promise-based.
      async () => await response.json()
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)), Effect.orDie);

const holderOf = (auth: Auth, token: string, resource = RESOURCE) =>
  Effect.promise(
    // @effect-diagnostics-next-line asyncFunction:off -- better-auth's api is Promise-based.
    async () => await auth.api.oauthTokenHolder({ body: { resource, token } })
  );

const Registered = Schema.Struct({ client_id: Schema.String });

const Redirect = Schema.Struct({ url: Schema.String });

const Tokens = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Finite,
  refresh_token: Schema.String,
  scope: Schema.String,
});

const Metadata = Schema.Struct({
  authorization_endpoint: Schema.String,
  code_challenge_methods_supported: Schema.Array(Schema.String),
  issuer: Schema.String,
  registration_endpoint: Schema.String,
  scopes_supported: Schema.Array(Schema.String),
  token_endpoint: Schema.String,
});

const pkce = Effect.promise(
  // @effect-diagnostics-next-line asyncFunction:off -- WebCrypto only exposes a Promise-returning digest.
  async () => {
    const verifier = Base64Url.encode(
      crypto.getRandomValues(new Uint8Array(32))
    );

    const challenge = Base64Url.encode(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier)
        )
      )
    );

    return { challenge, verifier };
  }
);

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");

const pathOf = (url: string) => {
  const parsed = new URL(url, ORIGIN);

  return `${parsed.pathname}${parsed.search}`;
};

const signIn = (auth: Auth, sent: MagicLinkRequest[], email: string) =>
  Effect.gen(function* signedInCookie() {
    yield* call(auth, "/api/auth/sign-in/magic-link", {
      body: JSON.stringify({ callbackURL: "/account", email }),
    });

    return cookieOf(yield* call(auth, pathOf(sent.at(-1)?.url ?? "")));
  });

const register = (auth: Auth) =>
  call(auth, "/api/auth/oauth2/register", {
    body: JSON.stringify({
      client_name: "ChatGPT",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    fetchSite: "cross-site",
  }).pipe(Effect.flatMap(jsonOf(Registered)));

const authorizePath = (clientId: string, challenge: string) =>
  `/api/auth/oauth2/authorize?${new URLSearchParams({
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    response_type: "code",
    scope: "mcp offline_access",
    state: "state-1",
  }).toString()}`;

const tokenRequest = (auth: Auth, fields: Record<string, string>) =>
  call(auth, "/api/auth/oauth2/token", {
    body: new URLSearchParams({ resource: RESOURCE, ...fields }).toString(),
    contentType: "application/x-www-form-urlencoded",
    fetchSite: "cross-site",
  });

const connected = Effect.gen(function* connected() {
  const { auth, database, sent } = makeAuth();
  const { client_id } = yield* register(auth);
  const { challenge, verifier } = yield* pkce;
  const cookie = yield* signIn(auth, sent, "member@example.com");

  const consent = yield* call(auth, authorizePath(client_id, challenge), {
    cookie,
  });

  const consentUrl = new URL(consent.headers.get("location") ?? "", ORIGIN);

  const approved = yield* call(auth, "/api/auth/oauth2/consent", {
    body: JSON.stringify({
      accept: true,
      oauth_query: consentUrl.search.slice(1),
    }),
    cookie,
  }).pipe(Effect.flatMap(jsonOf(Redirect)));

  const code = new URL(approved.url).searchParams.get("code") ?? "";

  const tokens = yield* tokenRequest(auth, {
    client_id,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  }).pipe(Effect.flatMap(jsonOf(Tokens)));

  return {
    approved,
    auth,
    client_id,
    consentUrl,
    cookie,
    database,
    sent,
    tokens,
  };
});

const refresh = (auth: Auth, clientId: string, refreshToken: string) =>
  tokenRequest(auth, {
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

const signOut = (auth: Auth, cookie: string) =>
  call(auth, "/api/auth/sign-out", { body: "{}", cookie });

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP OAuth provider", () => {
  it.effect(
    "serves authorization server metadata at the RFC 8414 path for the /api/auth issuer",
    () =>
      Effect.gen(function* metadata() {
        const { auth } = makeAuth();

        const served = yield* call(
          auth,
          "/.well-known/oauth-authorization-server/api/auth"
        ).pipe(Effect.flatMap(jsonOf(Metadata)));

        expect(served).toStrictEqual({
          authorization_endpoint: `${ORIGIN}/api/auth/oauth2/authorize`,
          code_challenge_methods_supported: ["S256"],
          issuer: `${ORIGIN}/api/auth`,
          registration_endpoint: `${ORIGIN}/api/auth/oauth2/register`,
          scopes_supported: ["mcp", "offline_access"],
          token_endpoint: `${ORIGIN}/api/auth/oauth2/token`,
        });
      })
  );

  it.effect(
    "sends a signed-out authorization to the connect page carrying the signed request",
    () =>
      Effect.gen(function* signedOut() {
        const { auth } = makeAuth();
        const { client_id } = yield* register(auth);
        const { challenge } = yield* pkce;

        const response = yield* call(auth, authorizePath(client_id, challenge));

        const location = new URL(
          response.headers.get("location") ?? "",
          ORIGIN
        );

        expect(response.status).toBe(302);
        expect(location.pathname).toBe(OAUTH_CONNECT_PATH);
        expect(location.searchParams.get("client_id")).toBe(client_id);
        expect(location.searchParams.has("sig")).toBe(true);
      })
  );

  it.effect(
    "issues prefixed tokens through consent and PKCE that resolve to the member",
    () =>
      Effect.gen(function* issued() {
        const { approved, auth, consentUrl, tokens } = yield* connected;

        expect(consentUrl.pathname).toBe(OAUTH_CONNECT_PATH);
        expect(new URL(approved.url).searchParams.get("state")).toBe("state-1");
        expect(tokens.access_token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)).toBe(
          true
        );
        expect(
          tokens.refresh_token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)
        ).toBe(true);
        expect(tokens.scope).toBe("mcp offline_access");

        const holder = yield* holderOf(auth, tokens.access_token);

        expect(holder).toMatchObject({ email: "member@example.com" });
      })
  );

  it.effect("refuses a token exchange without the PKCE verifier", () =>
    Effect.gen(function* missingVerifier() {
      const { auth, sent } = makeAuth();
      const { client_id } = yield* register(auth);
      const { challenge } = yield* pkce;
      const cookie = yield* signIn(auth, sent, "member@example.com");

      const consent = yield* call(auth, authorizePath(client_id, challenge), {
        cookie,
      });

      const approved = yield* call(auth, "/api/auth/oauth2/consent", {
        body: JSON.stringify({
          accept: true,
          oauth_query: new URL(
            consent.headers.get("location") ?? "",
            ORIGIN
          ).search.slice(1),
        }),
        cookie,
      }).pipe(Effect.flatMap(jsonOf(Redirect)));

      const response = yield* tokenRequest(auth, {
        client_id,
        code: new URL(approved.url).searchParams.get("code") ?? "",
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      });

      expect(response.status).toBe(400);
    })
  );

  it.effect("rotates the refresh token and retires the old one", () =>
    Effect.gen(function* rotated() {
      const { auth, client_id, tokens } = yield* connected;

      const refreshed = yield* tokenRequest(auth, {
        client_id,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      }).pipe(Effect.flatMap(jsonOf(Tokens)));

      const replayed = yield* tokenRequest(auth, {
        client_id,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      });

      expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
      expect(replayed.status).toBe(400);
      expect(yield* holderOf(auth, refreshed.access_token)).toBeNull();
    })
  );

  it.effect(
    "names no holder when the token was minted for another MCP server",
    () =>
      Effect.gen(function* otherResource() {
        const { auth, tokens } = yield* connected;

        expect(
          yield* holderOf(
            auth,
            tokens.access_token,
            "https://other.example/mcp"
          )
        ).toBeNull();
      })
  );

  it.effect("names no holder for an unknown or expired access token", () =>
    Effect.gen(function* refused() {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);

      const { auth, tokens } = yield* connected;

      expect(
        yield* holderOf(auth, `${OAUTH_ACCESS_TOKEN_PREFIX}not-a-real-token`)
      ).toBeNull();

      vi.setSystemTime(T0 + (tokens.expires_in + 1) * 1000);

      expect(yield* holderOf(auth, tokens.access_token)).toBeNull();
    })
  );

  it.effect(
    "keeps the connection working after the browser session it was granted from expires",
    () =>
      Effect.gen(function* sessionExpired() {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(T0);

        const { auth, client_id, database, tokens } = yield* connected;

        database
          .prepare("UPDATE session SET expiresAt = ?")
          .run("2026-11-19T11:59:59.000Z");

        expect(yield* holderOf(auth, tokens.access_token)).toMatchObject({
          email: "member@example.com",
        });

        const refreshed = yield* refresh(
          auth,
          client_id,
          tokens.refresh_token
        ).pipe(Effect.flatMap(jsonOf(Tokens)));

        expect(yield* holderOf(auth, refreshed.access_token)).toMatchObject({
          email: "member@example.com",
        });
      })
  );

  it.effect(
    "keeps the connection after an expired browser session is cleaned up",
    () =>
      Effect.gen(function* sessionCleanedUp() {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(T0);

        const { auth, client_id, cookie, database, tokens } = yield* connected;

        vi.setSystemTime(T0 + 8 * DAY_MS);

        yield* call(auth, "/api/auth/get-session", { cookie });

        expect(database.prepare("SELECT id FROM session").all()).toStrictEqual(
          []
        );

        const refreshed = yield* refresh(
          auth,
          client_id,
          tokens.refresh_token
        ).pipe(Effect.flatMap(jsonOf(Tokens)));

        expect(yield* holderOf(auth, refreshed.access_token)).toMatchObject({
          email: "member@example.com",
        });
      })
  );

  it.effect(
    "signing out of the browser that granted the connection revokes it",
    () =>
      Effect.gen(function* signedOut() {
        const { auth, client_id, cookie, tokens } = yield* connected;

        expect((yield* signOut(auth, cookie)).status).toBe(200);
        expect(yield* holderOf(auth, tokens.access_token)).toBeNull();
        expect(
          (yield* refresh(auth, client_id, tokens.refresh_token)).status
        ).toBe(400);
      })
  );

  it.effect(
    "signing out of the browser after a refresh revokes the refreshed tokens",
    () =>
      Effect.gen(function* signedOutAfterRefresh() {
        const { auth, client_id, cookie, tokens } = yield* connected;

        const refreshed = yield* refresh(
          auth,
          client_id,
          tokens.refresh_token
        ).pipe(Effect.flatMap(jsonOf(Tokens)));

        yield* signOut(auth, cookie);

        expect(yield* holderOf(auth, tokens.access_token)).toBeNull();
        expect(yield* holderOf(auth, refreshed.access_token)).toBeNull();
        expect(
          (yield* refresh(auth, client_id, refreshed.refresh_token)).status
        ).toBe(400);
      })
  );

  it.effect(
    "signing out after more refreshes than one query can bind still revokes the connection",
    () =>
      Effect.gen(function* signedOutAfterManyRefreshes() {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(T0);

        const { auth, client_id, cookie, database, tokens } = yield* connected;
        let latest = tokens;
        let previous = tokens;

        for (let hop = 1; hop <= 120; hop += 1) {
          vi.setSystemTime(T0 + hop * 4 * 60 * 1000);
          previous = latest;
          latest = yield* refresh(auth, client_id, latest.refresh_token).pipe(
            Effect.flatMap(jsonOf(Tokens))
          );
        }

        expect(
          database
            .prepare('SELECT COUNT(*) AS n FROM "oauthRefreshToken"')
            .get()
        ).toEqual({ n: 121 });

        expect((yield* signOut(auth, cookie)).status).toBe(200);

        expect(yield* holderOf(auth, latest.access_token)).toBeNull();
        expect(yield* holderOf(auth, previous.access_token)).toBeNull();
        expect(
          (yield* refresh(auth, client_id, latest.refresh_token)).status
        ).toBe(400);
      })
  );

  it.effect("signing out of another browser leaves the connection", () =>
    Effect.gen(function* otherBrowser() {
      const { auth, sent, tokens } = yield* connected;
      const other = yield* signIn(auth, sent, "member@example.com");

      yield* signOut(auth, other);

      expect(yield* holderOf(auth, tokens.access_token)).toMatchObject({
        email: "member@example.com",
      });
    })
  );
});
