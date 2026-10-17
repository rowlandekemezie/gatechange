// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test applies the checked-in migration SQL to a throwaway database before any Effect runs.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import { jobStoreMigrationDirectory } from "@rat-stack/job-store";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Effect } from "effect";

import { authOptions } from "../src/index.js";
import type { AuthSettings, MagicLinkRequest } from "../src/index.js";

const ORIGIN = "http://localhost:1337";

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

const settings = (sent: MagicLinkRequest[]): AuthSettings => ({
  allowedHosts: ["localhost:*"],
  fallbackOrigin: ORIGIN,
  // @effect-diagnostics-next-line asyncFunction:off -- better-auth calls the sender as a Promise-returning callback.
  sendMagicLink: async (request) => {
    sent.push(request);
    await Promise.resolve();
  },
  social: {},
});

const makeAuth = () => {
  const sent: MagicLinkRequest[] = [];
  const database = migratedDatabase();

  const auth = betterAuth({
    ...authOptions(settings(sent)),
    database,
    secret: "test-secret-test-secret-test-secret-0",
  });

  return { auth, database, sent };
};

type Auth = ReturnType<typeof makeAuth>["auth"];

interface Call {
  readonly body?: string;
  readonly cookie?: string;
  readonly ip?: string;
}

const call = (
  auth: Auth,
  path: string,
  { body, cookie = "", ip = "203.0.113.7" }: Call = {}
) =>
  Effect.promise(
    // @effect-diagnostics-next-line asyncFunction:off -- better-auth's handler is Promise-based.
    async () =>
      await auth.handler(
        new Request(`${ORIGIN}${path}`, {
          body: body ?? null,
          headers: {
            "cf-connecting-ip": ip,
            "content-type": "application/json",
            cookie,
            origin: ORIGIN,
          },
          method: body === undefined ? "GET" : "POST",
        })
      )
  );

const sessionOf = (auth: Auth, cookie: string) =>
  Effect.promise(
    // @effect-diagnostics-next-line asyncFunction:off -- better-auth's api is Promise-based.
    async () => await auth.api.getSession({ headers: new Headers({ cookie }) })
  );

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");

const requestLink = (auth: Auth, email: string, ip = "203.0.113.7") =>
  call(auth, "/api/auth/sign-in/magic-link", {
    body: JSON.stringify({ callbackURL: "/account", email }),
    ip,
  });

const pathOf = (url: string) => {
  const link = new URL(url);

  return `${link.pathname}${link.search}`;
};

describe("auth schema", () => {
  it.effect(
    "matches what better-auth expects, so the deploy needs no auth migration of its own",
    () =>
      Effect.gen(function* schemaMatches() {
        const migrations = yield* Effect.promise(
          // @effect-diagnostics-next-line asyncFunction:off -- better-auth's migration planner is Promise-based.
          async () =>
            await getMigrations({
              ...authOptions(settings([])),
              database: migratedDatabase(),
            })
        );

        expect(migrations.toBeCreated).toStrictEqual([]);
        expect(migrations.toBeAdded).toStrictEqual([]);
      })
  );
});

describe("magic link sign-in", () => {
  it.effect(
    "emails one link, signs the viewer in once, and refuses the same link again",
    () =>
      Effect.gen(function* signIn() {
        const { auth, sent } = makeAuth();

        const requested = yield* requestLink(auth, "ada@example.com");

        expect(requested.status).toBe(200);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.email).toBe("ada@example.com");

        const link = pathOf(sent[0]?.url ?? "");
        const verified = yield* call(auth, link);

        expect(verified.status).toBe(302);
        expect(verified.headers.get("location")).toBe(`${ORIGIN}/account`);

        const [sessionCookie] = verified.headers.getSetCookie();

        expect(sessionCookie).toMatch(/^__Secure-better-auth\.session_token=/u);
        expect(sessionCookie).toContain("Secure");
        expect(sessionCookie).toContain("HttpOnly");

        const session = yield* sessionOf(auth, cookieOf(verified));

        expect(session?.user.email).toBe("ada@example.com");

        const reused = yield* call(auth, link);

        expect(cookieOf(reused)).not.toContain("session_token=");
        expect(reused.headers.get("location")).toContain("error=");
      })
  );

  it.effect(
    "refuses a sixth link from one address within a minute, while another address still gets one",
    () =>
      Effect.gen(function* rateLimited() {
        const { auth, sent } = makeAuth();
        const statuses: number[] = [];

        for (const email of [
          "a@example.com",
          "b@example.com",
          "c@example.com",
          "d@example.com",
          "e@example.com",
          "f@example.com",
        ]) {
          statuses.push((yield* requestLink(auth, email)).status);
        }

        const elsewhere = yield* requestLink(
          auth,
          "g@example.com",
          "198.51.100.9"
        );

        expect(statuses).toStrictEqual([200, 200, 200, 200, 200, 429]);
        expect(elsewhere.status).toBe(200);
        expect(sent.map(({ email }) => email)).toStrictEqual([
          "a@example.com",
          "b@example.com",
          "c@example.com",
          "d@example.com",
          "e@example.com",
          "g@example.com",
        ]);
      })
  );

  it.effect("rejects a malformed email without sending anything", () =>
    Effect.gen(function* badEmail() {
      const { auth, sent } = makeAuth();

      const response = yield* requestLink(auth, "not-an-email");

      expect(response.status).toBe(400);
      expect(sent).toHaveLength(0);
    })
  );

  it.effect("signs out by revoking the session row", () =>
    Effect.gen(function* signOut() {
      const { auth, database, sent } = makeAuth();

      yield* requestLink(auth, "ada@example.com");

      const verified = yield* call(auth, pathOf(sent[0]?.url ?? ""));
      const cookie = cookieOf(verified);

      const out = yield* call(auth, "/api/auth/sign-out", {
        body: "{}",
        cookie,
      });

      expect(out.status).toBe(200);
      expect(yield* sessionOf(auth, cookie)).toBeNull();
      expect(
        database.prepare('SELECT count(*) AS n FROM "session"').get()
      ).toEqual({ n: 0 });
    })
  );
});
