// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test applies the checked-in migration SQL to a throwaway database before any Effect runs.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { MAGIC_LINK_TTL_MINUTES, siteHostsOf } from "@rat-stack/core";
import type { SiteHosts } from "@rat-stack/core";
import { jobStoreMigrationDirectory } from "@rat-stack/job-store";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { DateTime, Effect, Option } from "effect";
import { vi } from "vitest";

import { authOptions, EMAIL_SEND_LIMIT } from "../src/index.js";
import type { AuthSettings, MagicLinkRequest } from "../src/index.js";

const ORIGIN = "http://localhost:1337";

const LOCAL_HOSTS: SiteHosts = {
  allowedHosts: ["localhost:*"],
  fallbackOrigin: Option.some(ORIGIN),
};

const MINUTE = 60_000;

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

const settings = (
  sent: MagicLinkRequest[],
  hosts: SiteHosts = LOCAL_HOSTS
): AuthSettings => ({
  hosts,
  // @effect-diagnostics-next-line asyncFunction:off -- better-auth calls the sender as a Promise-returning callback.
  sendMagicLink: async (request) => {
    sent.push(request);
    await Promise.resolve();
  },
  social: {},
});

const makeAuth = (hosts: SiteHosts = LOCAL_HOSTS) => {
  const sent: MagicLinkRequest[] = [];
  const database = migratedDatabase();

  const auth = betterAuth({
    ...authOptions(settings(sent, hosts)),
    database,
    secret: "test-secret-test-secret-test-secret-0",
  });

  return { auth, database, sent };
};

type Auth = ReturnType<typeof makeAuth>["auth"];

interface Call {
  readonly at?: string;
  readonly body?: string;
  readonly cookie?: string;
  readonly from?: string;
  readonly ip?: string;
}

const call = (
  auth: Auth,
  path: string,
  { at = ORIGIN, body, cookie = "", from = at, ip = "203.0.113.7" }: Call = {}
) =>
  Effect.promise(
    // @effect-diagnostics-next-line asyncFunction:off -- better-auth's handler is Promise-based.
    async () =>
      await auth.handler(
        new Request(`${at}${path}`, {
          body: body ?? null,
          headers: {
            "cf-connecting-ip": ip,
            "content-type": "application/json",
            cookie,
            origin: from,
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

const requestLink = (
  auth: Auth,
  email: string,
  ip = "203.0.113.7",
  where: Pick<Call, "at" | "from"> = {}
) =>
  call(auth, "/api/auth/sign-in/magic-link", {
    ...where,
    body: JSON.stringify({ callbackURL: "/account", email }),
    ip,
  });

const statusOf = (response: Effect.Effect<Response>) =>
  response.pipe(
    Effect.map(({ status }) => status),
    Effect.catchDefect(() => Effect.succeed(500))
  );

const pathOf = (url: string) => {
  const link = new URL(url);

  return `${link.pathname}${link.search}`;
};

const tokenOf = (url: string) => new URL(url).searchParams.get("token") ?? "";

const travelTo = (millis: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(millis);
};

const T0 = Date.UTC(2026, 9, 17, 12);

afterEach(() => {
  vi.useRealTimers();
});

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

describe("magic link storage and lifetime", () => {
  it.effect("stores only a hash of the emailed token", () =>
    Effect.gen(function* hashed() {
      const { auth, database, sent } = makeAuth();

      yield* requestLink(auth, "ada@example.com");

      const token = tokenOf(sent[0]?.url ?? "");

      const rows = database
        .prepare('SELECT identifier FROM "verification"')
        .all();

      expect(token).toHaveLength(32);
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.identifier)).toMatch(/^magic-link:/u);
      expect(String(rows[0]?.identifier)).not.toContain(token);
    })
  );

  it.effect(
    `expires a link ${MAGIC_LINK_TTL_MINUTES} minutes after it was sent`,
    () =>
      Effect.gen(function* expires() {
        travelTo(T0);

        const { auth, database, sent } = makeAuth();

        yield* requestLink(auth, "ada@example.com");
        yield* requestLink(auth, "bob@example.com", "198.51.100.9");

        const expiries = database
          .prepare('SELECT "expiresAt" AS at FROM "verification"')
          .all()
          .map(({ at }) => at);

        const expected = DateTime.formatIso(
          DateTime.makeUnsafe(T0 + MAGIC_LINK_TTL_MINUTES * MINUTE)
        );

        expect(expiries).toStrictEqual([expected, expected]);

        travelTo(T0 + (MAGIC_LINK_TTL_MINUTES - 1) * MINUTE);

        const early = yield* call(auth, pathOf(sent[0]?.url ?? ""));

        travelTo(T0 + MAGIC_LINK_TTL_MINUTES * MINUTE + 1000);

        const late = yield* call(auth, pathOf(sent[1]?.url ?? ""));

        expect(cookieOf(early)).toContain("session_token=");
        expect(cookieOf(late)).not.toContain("session_token=");
        expect(late.headers.get("location")).toContain("error=");
      })
  );

  it.effect("keeps the per-client limiter in the database", () =>
    Effect.gen(function* databaseLimiter() {
      const { auth, database } = makeAuth();

      yield* requestLink(auth, "ada@example.com");

      const keys = database
        .prepare('SELECT key FROM "rateLimit" ORDER BY key')
        .all()
        .map(({ key }) => String(key));

      expect(keys).toStrictEqual([
        "203.0.113.7|/sign-in/magic-link",
        "magic-link-email:ada@example.com",
      ]);
    })
  );
});

describe("per-email send limit", () => {
  it.effect(
    `sends at most ${EMAIL_SEND_LIMIT.max} links to one inbox in 15 minutes, whatever the client address or +tag`,
    () =>
      Effect.gen(function* perEmail() {
        travelTo(T0);

        const { auth, sent } = makeAuth();
        const statuses: number[] = [];

        for (const [index, email] of [
          "victim@example.com",
          "Victim@Example.com",
          "victim+a@example.com",
          "victim+b@example.com",
        ].entries()) {
          statuses.push(
            (yield* requestLink(auth, email, `2001:db8:${index}::1`)).status
          );
        }

        const bystander = yield* requestLink(
          auth,
          "other@example.com",
          "2001:db8:9::1"
        );

        expect(statuses).toStrictEqual([200, 200, 200, 429]);
        expect(bystander.status).toBe(200);
        expect(sent).toHaveLength(4);

        travelTo(T0 + EMAIL_SEND_LIMIT.windowSeconds * 1000 + 1000);

        const later = yield* requestLink(
          auth,
          "victim@example.com",
          "2001:db8:a::1"
        );

        expect(later.status).toBe(200);
      })
  );

  it.effect(
    "keeps counting an inbox when the per-client limiter prunes its own rows",
    () =>
      Effect.gen(function* survivesPruning() {
        travelTo(T0);

        const { auth } = makeAuth();

        for (const ip of ["2001:db8:1::1", "2001:db8:2::1", "2001:db8:3::1"]) {
          yield* requestLink(auth, "victim@example.com", ip);
        }

        travelTo(T0 + 2 * MINUTE);

        yield* requestLink(auth, "other@example.com", "2001:db8:1::1");

        const again = yield* requestLink(
          auth,
          "victim@example.com",
          "2001:db8:4::1"
        );

        expect(again.status).toBe(429);
      })
  );
});

describe("request origin", () => {
  it.effect("refuses a sign-in request posted from another site", () =>
    Effect.gen(function* hostileOrigin() {
      const { auth, sent } = makeAuth();

      const response = yield* requestLink(auth, "ada@example.com", undefined, {
        from: "https://evil.example",
      });

      expect(response.status).toBe(403);
      expect(sent).toHaveLength(0);
    })
  );
});

describe("stage hosts", () => {
  const PREVIEW = "https://jobs-verify-x.acct.workers.dev";

  const PROD = "https://jobs.rowlandekemezie.com";

  it.effect("emails a preview stage's own workers.dev link", () =>
    Effect.gen(function* previewLink() {
      const { auth, sent } = makeAuth(siteHostsOf("verify-x", []));

      const response = yield* requestLink(auth, "ada@example.com", undefined, {
        at: PREVIEW,
      });

      expect(response.status).toBe(200);
      expect(sent[0]?.url).toMatch(
        /^https:\/\/jobs-verify-x\.acct\.workers\.dev\/api\/auth\/magic-link\/verify\?/u
      );
    })
  );

  it.effect("never trusts the prod site from a preview stage", () =>
    Effect.gen(function* previewDistrustsProd() {
      const { auth, sent } = makeAuth(siteHostsOf("verify-x", []));

      const fromProd = yield* requestLink(auth, "ada@example.com", undefined, {
        at: PREVIEW,
        from: PROD,
      });

      const atProd = yield* statusOf(
        requestLink(auth, "bob@example.com", "198.51.100.9", { at: PROD })
      );

      expect(fromProd.status).toBe(403);
      expect(atProd).not.toBe(200);
      expect(sent).toHaveLength(0);
    })
  );

  it.effect(
    "keeps prod on its own domain even when local hosts are configured",
    () =>
      Effect.gen(function* prodOnly() {
        const { auth, sent } = makeAuth(siteHostsOf("prod", ["localhost:*"]));

        const local = yield* requestLink(auth, "ada@example.com", undefined, {
          at: ORIGIN,
        });

        const prod = yield* requestLink(
          auth,
          "bob@example.com",
          "198.51.100.9",
          { at: PROD }
        );

        expect(local.status).toBe(403);
        expect(prod.status).toBe(200);
        expect(sent.map(({ url }) => new URL(url).origin)).toStrictEqual([
          PROD,
        ]);
      })
  );
});
