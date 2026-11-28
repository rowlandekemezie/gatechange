// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test applies the checked-in migration SQL to a throwaway database before any Effect runs.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The D1 shim is Promise-based, so its gates wait on the event loop rather than an Effect fiber.
import { setImmediate as nextMacrotask } from "node:timers/promises";

import { describe, expect, it } from "@effect/vitest";
import { jobStoreMigrationDirectory } from "@rat-stack/job-store";
import { betterAuth } from "better-auth";
import { Effect, Option, Schema } from "effect";
import { Base64Url } from "effect/encoding";

import { authOptions } from "../src/index.js";
import type { MagicLinkRequest } from "../src/index.js";

const ORIGIN = "http://localhost:1337";

const RESOURCE = `${ORIGIN}/mcp`;

const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";

interface Latch {
  open: boolean;
}

interface Gate {
  readonly after?: Latch;
  readonly before?: Latch;
  readonly entered?: Latch;
}

type Gates = (sql: string) => Gate;

const runOn = (
  database: DatabaseSync,
  sql: string,
  values: readonly SQLInputValue[]
) => {
  const prepared = database.prepare(sql);
  const inputs = [...values];

  if (prepared.columns().length === 0) {
    const result = prepared.run(...inputs);

    return {
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
      results: [],
    };
  }

  const results = prepared.all(...inputs);

  return {
    meta: {
      changes: /^\s*select/iu.test(sql) ? 0 : results.length,
      last_row_id: 0,
    },
    results,
  };
};

const gatedD1 = (database: DatabaseSync, gates: { current: Gates }) => {
  // @effect-diagnostics-next-line asyncFunction:off -- D1 statements are Promise-based.
  const through = async <A>(sql: string, run: () => A) => {
    const gate = gates.current(sql);

    if (gate.entered !== undefined) {
      gate.entered.open = true;
    }

    while (gate.before !== undefined && !gate.before.open) {
      // oxlint-disable-next-line no-await-in-loop -- The gate holds this statement until the other request reaches its step in the model's path.
      await nextMacrotask();
    }

    const result = run();

    if (gate.after !== undefined) {
      gate.after.open = true;
    }

    return result;
  };

  const statementOf = (sql: string, values: readonly SQLInputValue[]) => ({
    // @effect-diagnostics-next-line asyncFunction:off -- D1 statements are Promise-based.
    all: async () => await through(sql, () => runOn(database, sql, values)),
    bind: (...bound: SQLInputValue[]) => statementOf(sql, bound),
    sql,
    values,
  });

  return {
    // @effect-diagnostics-next-line asyncFunction:off -- D1 batches are Promise-based.
    batch: async (
      statements: readonly { sql: string; values: readonly SQLInputValue[] }[]
    ) =>
      await through(statements.map(({ sql }) => sql).join(";\n"), () => {
        database.exec("BEGIN");

        try {
          const results = statements.map(({ sql, values }) =>
            runOn(database, sql, values)
          );

          database.exec("COMMIT");

          return results;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }),
    // @effect-diagnostics-next-line asyncFunction:off -- D1 exec is Promise-based.
    exec: async (sql: string) => {
      await Promise.resolve();
      database.exec(sql);
    },
    prepare: (sql: string) => statementOf(sql, []),
  };
};

const openGates: Gates = () => ({});

const latch = (): Latch => ({ open: false });

const makeAuth = () => {
  const sent: MagicLinkRequest[] = [];
  const database = new DatabaseSync(":memory:");
  const directory = jobStoreMigrationDirectory();

  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    database.exec(readFileSync(`${directory}${file}`, "utf-8"));
  }

  const gates = { current: openGates };

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
    // SAFETY: better-auth treats any object with prepare, batch and exec as a D1 binding, and gatedD1 implements the calls its D1 dialect makes.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The shim types bound values as node:sqlite inputs, narrower than D1's unknown, and better-auth only binds such values.
    database: gatedD1(database, gates) as never,
    secret: "test-secret-test-secret-test-secret-0",
  });

  return { auth, database, gates, sent };
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

const holderOf = (auth: Auth, token: string) =>
  Effect.promise(
    // @effect-diagnostics-next-line asyncFunction:off -- better-auth's api is Promise-based.
    async () =>
      await auth.api.oauthTokenHolder({ body: { resource: RESOURCE, token } })
  );

const Registered = Schema.Struct({ client_id: Schema.String });

const Redirect = Schema.Struct({ url: Schema.String });

const Tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
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

const tokenRequest = (auth: Auth, fields: Record<string, string>) =>
  call(auth, "/api/auth/oauth2/token", {
    body: new URLSearchParams({ resource: RESOURCE, ...fields }).toString(),
    contentType: "application/x-www-form-urlencoded",
    fetchSite: "cross-site",
  });

const connected = Effect.gen(function* connected() {
  const { auth, database, gates, sent } = makeAuth();

  const { client_id } = yield* call(auth, "/api/auth/oauth2/register", {
    body: JSON.stringify({
      client_name: "ChatGPT",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    fetchSite: "cross-site",
  }).pipe(Effect.flatMap(jsonOf(Registered)));

  const { challenge, verifier } = yield* pkce;

  yield* call(auth, "/api/auth/sign-in/magic-link", {
    body: JSON.stringify({
      callbackURL: "/account",
      email: "member@example.com",
    }),
  });

  const cookie = cookieOf(yield* call(auth, pathOf(sent.at(-1)?.url ?? "")));

  const consent = yield* call(
    auth,
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      client_id,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
      response_type: "code",
      scope: "mcp offline_access",
      state: "state-1",
    }).toString()}`,
    { cookie }
  );

  const consentUrl = new URL(consent.headers.get("location") ?? "", ORIGIN);

  const approved = yield* call(auth, "/api/auth/oauth2/consent", {
    body: JSON.stringify({
      accept: true,
      oauth_query: consentUrl.search.slice(1),
    }),
    cookie,
  }).pipe(Effect.flatMap(jsonOf(Redirect)));

  const tokens = yield* tokenRequest(auth, {
    client_id,
    code: new URL(approved.url).searchParams.get("code") ?? "",
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  }).pipe(Effect.flatMap(jsonOf(Tokens)));

  return { auth, client_id, cookie, database, gates, tokens };
});

const refresh = (auth: Auth, clientId: string, refreshToken: string) =>
  tokenRequest(auth, {
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

const signOut = (auth: Auth, cookie: string) =>
  call(auth, "/api/auth/sign-out", { body: "{}", cookie });

const isNewRefreshToken = (sql: string) =>
  sql.startsWith('insert into "oauthRefreshToken"');

const isNewAccessToken = (sql: string) =>
  sql.startsWith('insert into "oauthAccessToken"');

const isRotation = (sql: string) =>
  sql.startsWith('update "oauthRefreshToken"') &&
  sql.includes('"oauthRefreshToken"."revoked" is null');

const isGrantLookup = (sql: string) =>
  sql.includes(
    'where ("oauthRefreshToken"."sessionId" = ? and "oauthRefreshToken"."revoked" is null)'
  );

const isSessionDelete = (sql: string) => /delete from "session"/iu.test(sql);

const liveRefreshTokens = (database: DatabaseSync) =>
  database
    .prepare(
      'SELECT COUNT(*) AS n FROM "oauthRefreshToken" WHERE "revoked" IS NULL'
    )
    .get();

describe("server-oauth-signout model replay", () => {
  it.effect.fails(
    "SignOutEndsEveryConnection: sign-out ends a connection that refreshes while sign-out looks up grants",
    () =>
      Effect.gen(function* racedSignOut() {
        const { auth, client_id, cookie, database, gates, tokens } =
          yield* connected;

        const rotated = latch();
        const signOutStarted = latch();
        const newKeyStored = latch();

        gates.current = (sql) => {
          if (isNewRefreshToken(sql)) {
            return { before: signOutStarted };
          }

          if (isNewAccessToken(sql)) {
            return { after: newKeyStored };
          }

          if (isRotation(sql)) {
            return { after: rotated };
          }

          if (isSessionDelete(sql)) {
            return { before: newKeyStored, entered: signOutStarted };
          }

          if (isGrantLookup(sql)) {
            return { after: signOutStarted, before: rotated };
          }

          return {};
        };

        const [refreshed, signedOut] = yield* Effect.all(
          [
            refresh(auth, client_id, tokens.refresh_token),
            signOut(auth, cookie),
          ],
          { concurrency: 2 }
        );

        gates.current = openGates;

        expect(refreshed.status).toBe(200);
        expect(signedOut.status).toBe(200);

        const fresh = yield* jsonOf(Tokens)(refreshed);

        expect(yield* holderOf(auth, fresh.access_token)).toBeNull();
        expect(
          (yield* refresh(auth, client_id, fresh.refresh_token)).status
        ).toBe(400);
        expect(liveRefreshTokens(database)).toEqual({ n: 0 });
      })
  );

  it.effect(
    "SignOutEndsEveryConnection: a refresh that stored its refresh token but not its access token when sign-out lands gets no new key",
    () =>
      Effect.gen(function* halfMintedRefresh() {
        const { auth, client_id, cookie, database, gates, tokens } =
          yield* connected;

        const newRefreshStored = latch();
        const sessionGone = latch();

        gates.current = (sql) => {
          if (isNewRefreshToken(sql)) {
            return { after: newRefreshStored };
          }

          if (isSessionDelete(sql)) {
            return { after: sessionGone, before: newRefreshStored };
          }

          if (isGrantLookup(sql)) {
            return { before: newRefreshStored };
          }

          if (isNewAccessToken(sql)) {
            return { before: sessionGone };
          }

          return {};
        };

        const [refreshed, signedOut] = yield* Effect.all(
          [
            refresh(auth, client_id, tokens.refresh_token),
            signOut(auth, cookie),
          ],
          { concurrency: 2 }
        );

        gates.current = openGates;

        expect(signedOut.status).toBe(200);
        expect(refreshed.status).not.toBe(200);
        expect(
          (yield* refresh(auth, client_id, tokens.refresh_token)).status
        ).toBe(400);
        expect(liveRefreshTokens(database)).toEqual({ n: 0 });
      })
  );

  it.effect(
    "SignOutEndsEveryConnection: sign-out after a finished refresh ends the refreshed connection",
    () =>
      Effect.gen(function* signOutAfterRefresh() {
        const { auth, client_id, cookie, database, tokens } = yield* connected;

        const fresh = yield* refresh(
          auth,
          client_id,
          tokens.refresh_token
        ).pipe(Effect.flatMap(jsonOf(Tokens)));

        expect((yield* signOut(auth, cookie)).status).toBe(200);
        expect(liveRefreshTokens(database)).toEqual({ n: 0 });
        expect(yield* holderOf(auth, fresh.access_token)).toBeNull();
      })
  );

  it.effect(
    "SignOutEndsEveryConnection: a refresh that lands after the session is gone gets no new key",
    () =>
      Effect.gen(function* refreshAfterSessionGone() {
        const { auth, client_id, cookie, database, gates, tokens } =
          yield* connected;

        const sessionGone = latch();
        const rotated = latch();

        gates.current = (sql) => {
          if (isRotation(sql)) {
            return { after: rotated };
          }

          if (isSessionDelete(sql)) {
            return { after: sessionGone, before: rotated };
          }

          if (isGrantLookup(sql)) {
            return { before: rotated };
          }

          if (isNewRefreshToken(sql)) {
            return { before: sessionGone };
          }

          return {};
        };

        const [refreshed] = yield* Effect.all(
          [
            refresh(auth, client_id, tokens.refresh_token),
            signOut(auth, cookie),
          ],
          { concurrency: 2 }
        );

        gates.current = openGates;

        expect(refreshed.status).not.toBe(200);
        expect(liveRefreshTokens(database)).toEqual({ n: 0 });
      })
  );

  it.effect(
    "ConnectionsLiveWhileSignedIn: a refresh while signed in keeps the connection",
    () =>
      Effect.gen(function* refreshWhileSignedIn() {
        const { auth, client_id, tokens } = yield* connected;

        const fresh = yield* refresh(
          auth,
          client_id,
          tokens.refresh_token
        ).pipe(Effect.flatMap(jsonOf(Tokens)));

        expect(yield* holderOf(auth, fresh.access_token)).toMatchObject({
          email: "member@example.com",
        });
      })
  );
});
