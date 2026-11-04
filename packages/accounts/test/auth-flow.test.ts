// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test applies the checked-in migration SQL to a throwaway database before any Effect runs.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { format } from "node:util";

import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  CurrentViewer,
  JobStoreUnavailable,
  MAGIC_LINK_TTL_MINUTES,
  siteHostsOf,
  trackJob,
} from "@rat-stack/core";
import type { SiteHosts } from "@rat-stack/core";
import {
  jobStoreMigrationDirectory,
  SqlExecutor,
  trackerStoreLayer,
} from "@rat-stack/job-store";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { vi } from "vitest";

import {
  CLIENT_DAILY_SEND_LIMIT,
  INBOX_DAILY_SEND_LIMIT,
  newAddressDailySendLimit,
} from "../src/email-send-limit.js";
import {
  authOptions,
  EMAIL_SEND_LIMIT,
  makeAccountStore,
  respondAsViewer,
  viewerOfRequest,
} from "../src/index.js";
import type { AuthSettings, MagicLinkRequest } from "../src/index.js";
import { SendEmailError } from "./fixtures/send-email-error.js";

const ORIGIN = "http://localhost:1337";

const LOCAL_HOSTS: SiteHosts = {
  allowedHosts: ["localhost:*"],
  fallbackOrigin: Option.some(ORIGIN),
};

const MINUTE = 60_000;

class RecordingDatabase extends DatabaseSync {
  readonly statements: string[] = [];

  override prepare(...args: Parameters<DatabaseSync["prepare"]>) {
    this.statements.push(args[0]);

    return super.prepare(...args);
  }
}

const migrate = <D extends DatabaseSync>(database: D) => {
  const directory = jobStoreMigrationDirectory();

  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    database.exec(readFileSync(`${directory}${file}`, "utf-8"));
  }

  return database;
};

const migratedDatabase = () => migrate(new DatabaseSync(":memory:"));

const refusingLimiterInserts = () => {
  const database = migratedDatabase();

  database.exec(`
    CREATE TRIGGER refuse_magic_link_counts BEFORE INSERT ON "rateLimit"
    WHEN NEW.key LIKE 'magic-link-%'
    BEGIN SELECT RAISE(ABORT, 'D1 refused the write'); END;
  `);

  return database;
};

const RACED_KEY = "magic-link-attempt:victim@example.com";

const losingFirstCountRace = () => {
  const database = migratedDatabase();

  database.exec(`
    CREATE TRIGGER first_count_race BEFORE INSERT ON "rateLimit"
    WHEN NEW.key = '${RACED_KEY}' AND NEW.id <> 'racer'
    BEGIN
      INSERT INTO "rateLimit" (id, key, count, "lastRequest")
        VALUES ('racer', NEW.key, 1, NEW."lastRequest");
      SELECT RAISE(FAIL, 'UNIQUE constraint failed: rateLimit.key');
    END;
  `);

  return database;
};

type Mailer = (request: MagicLinkRequest) => boolean | Error;

const settings = (
  sent: MagicLinkRequest[],
  hosts: SiteHosts = LOCAL_HOSTS,
  mailer: Mailer = () => true
): AuthSettings => ({
  hosts,
  // @effect-diagnostics-next-line asyncFunction:off -- better-auth calls the sender as a Promise-returning callback.
  sendMagicLink: async (request) => {
    const outcome = mailer(request);

    await (outcome === true
      ? Promise.resolve(sent.push(request))
      : Promise.reject(
          outcome instanceof Error ? outcome : new Error("mailer down")
        ));
  },
  social: {},
});

const longAddress = (lastLabel: number) =>
  `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(lastLabel)}.com`;

const cloudflareSendError = (code: string) =>
  Object.assign(new Error("send_email failed"), {
    cause: Object.assign(new Error(code), { code }),
  });

const makeAuth = (
  hosts: SiteHosts = LOCAL_HOSTS,
  database: DatabaseSync = migratedDatabase(),
  mailer: Mailer = () => true,
  magicLinkDailySendLimit = 900
) => {
  const sent: MagicLinkRequest[] = [];

  const auth = betterAuth({
    ...authOptions({
      ...settings(sent, hosts, mailer),
      magicLinkDailySendLimit,
    }),
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
  readonly fetchSite?: string | undefined;
  readonly forwardedFor?: string;
  readonly from?: string;
  readonly ip?: string;
}

const call = (
  auth: Auth,
  path: string,
  {
    at = ORIGIN,
    body,
    cookie = "",
    fetchSite,
    forwardedFor,
    from = at,
    ip = "203.0.113.7",
  }: Call = {}
) =>
  Effect.promise(
    // @effect-diagnostics-next-line asyncFunction:off -- better-auth's handler is Promise-based.
    async () => {
      const headers = new Headers({
        "cf-connecting-ip": ip,
        "content-type": "application/json",
        cookie,
        origin: from,
      });

      if (fetchSite !== undefined) {
        headers.set("sec-fetch-site", fetchSite);
      }

      if (forwardedFor !== undefined) {
        headers.set("x-forwarded-for", forwardedFor);
      }

      return await auth.handler(
        new Request(`${at}${path}`, {
          body: body ?? null,
          headers,
          method: body === undefined ? "GET" : "POST",
        })
      );
    }
  );

const CONFIRM_FORM: Call = { fetchSite: "same-origin" };

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
  where: Pick<Call, "at" | "forwardedFor" | "from"> = {}
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
  vi.restoreAllMocks();
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
    "keeps a failed send's recipient out of better-auth's logs while retaining its tag and provider code",
    () =>
      Effect.gen(function* privateFailure() {
        const recipient = "private.recipient+signin@example.com";

        const errorLog = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});

        const { auth } = makeAuth(
          LOCAL_HOSTS,
          migratedDatabase(),
          () =>
            new SendEmailError({
              cause: Object.assign(
                new Error(`email to ${recipient} not allowed`),
                {
                  code: "E_RECIPIENT_SUPPRESSED",
                }
              ),
              message: "send_email failed",
            })
        );

        expect(yield* statusOf(requestLink(auth, recipient))).toBe(500);

        const logged = errorLog.mock.calls
          .map((args) => format(...args))
          .join("\n");

        expect(logged).toContain("SendEmailError");
        expect(logged).toContain("E_RECIPIENT_SUPPRESSED");
        expect(logged).not.toContain(recipient);
        expect(logged).not.toContain("email to");
      })
  );

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
        const verified = yield* call(auth, link, CONFIRM_FORM);

        expect(verified.status).toBe(302);
        expect(verified.headers.get("location")).toBe(`${ORIGIN}/account`);

        const [sessionCookie] = verified.headers.getSetCookie();

        expect(sessionCookie).toMatch(/^__Secure-better-auth\.session_token=/u);
        expect(sessionCookie).toContain("Secure");
        expect(sessionCookie).toContain("HttpOnly");

        const session = yield* sessionOf(auth, cookieOf(verified));

        expect(session?.user.email).toBe("ada@example.com");

        const reused = yield* call(auth, link, CONFIRM_FORM);

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

      const verified = yield* call(
        auth,
        pathOf(sent[0]?.url ?? ""),
        CONFIRM_FORM
      );

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

        const early = yield* call(
          auth,
          pathOf(sent[0]?.url ?? ""),
          CONFIRM_FORM
        );

        travelTo(T0 + MAGIC_LINK_TTL_MINUTES * MINUTE + 1000);

        const late = yield* call(
          auth,
          pathOf(sent[1]?.url ?? ""),
          CONFIRM_FORM
        );

        expect(cookieOf(early)).toContain("session_token=");
        expect(cookieOf(late)).not.toContain("session_token=");
        expect(late.headers.get("location")).toContain("error=");
      })
  );

  it.effect("keeps the per-client limiter in the database", () =>
    Effect.gen(function* databaseLimiter() {
      travelTo(T0);

      const { auth, database } = makeAuth();

      yield* requestLink(auth, "ada@example.com");

      const keys = database
        .prepare('SELECT key FROM "rateLimit" ORDER BY key')
        .all()
        .map(({ key }) => String(key));

      expect(keys).toStrictEqual([
        "203.0.113.7|/sign-in/magic-link",
        "magic-link-attempt:ada@example.com",
        "magic-link-client:2026-10-17:203.0.113.7",
        "magic-link-email:ada@example.com",
        "magic-link-global:2026-10-17",
        "magic-link-inbox:2026-10-17:ada@example.com",
        "magic-link-new:2026-10-17",
      ]);
    })
  );
});

describe("per-email send limit", () => {
  it.effect(
    `sends at most ${EMAIL_SEND_LIMIT.max} links to one address in 15 minutes, whatever the client address or letter case`,
    () =>
      Effect.gen(function* perEmail() {
        travelTo(T0);

        const { auth, sent } = makeAuth();
        const statuses: number[] = [];

        for (const [index, email] of [
          "victim@example.com",
          "Victim@Example.com",
          "VICTIM@example.com",
          "victim@EXAMPLE.COM",
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
    "atomically caps sign-in sends across different addresses and IPs without extending refusals",
    () =>
      Effect.gen(function* globalBudget() {
        travelTo(T0);

        const { auth, database, sent } = makeAuth(
          LOCAL_HOSTS,
          migratedDatabase(),
          () => true,
          7
        );

        const responses = yield* Effect.forEach(
          Array.from({ length: 12 }, (_, index) => index),
          (index) =>
            requestLink(
              auth,
              `member${index}@example.com`,
              `2001:db8:${index}::1`
            ),
          { concurrency: 4 }
        );

        expect(
          responses.filter((response) => response.status === 200)
        ).toHaveLength(3);
        expect(
          responses.filter((response) => response.status === 429)
        ).toHaveLength(9);
        expect(sent).toHaveLength(3);

        const before = database
          .prepare('SELECT count, lastRequest FROM "rateLimit" WHERE key = ?')
          .get("magic-link-global:2026-10-17");

        travelTo(T0 + 11 * 60 * MINUTE + 59 * MINUTE);
        expect(
          (yield* requestLink(auth, "late@example.com", "2001:db8:ff::1"))
            .status
        ).toBe(429);
        expect(
          database
            .prepare('SELECT count, lastRequest FROM "rateLimit" WHERE key = ?')
            .get("magic-link-global:2026-10-17")
        ).toEqual(before);
        travelTo(T0 + 12 * 60 * MINUTE);
        expect(
          (yield* requestLink(auth, "next@example.com", "2001:db8:fe::1"))
            .status
        ).toBe(200);
        expect(sent).toHaveLength(4);
      })
  );

  it.effect(
    "resets the global budget at UTC midnight, so a send 23 hours after the cap filled goes out",
    () =>
      Effect.gen(function* midnightReset() {
        travelTo(T0);

        const { auth, sent } = makeAuth(
          LOCAL_HOSTS,
          migratedDatabase(),
          () => true,
          1
        );

        const first = yield* requestLink(
          auth,
          "first@example.com",
          "2001:db8:1::1"
        );

        const refused = yield* requestLink(
          auth,
          "second@example.com",
          "2001:db8:2::1"
        );

        travelTo(T0 + 23 * 60 * MINUTE);

        const nextDay = yield* requestLink(
          auth,
          "third@example.com",
          "2001:db8:3::1"
        );

        expect([first.status, refused.status, nextDay.status]).toStrictEqual([
          200, 429, 200,
        ]);
        expect(sent).toHaveLength(2);
      })
  );

  it.effect(
    "never lets steady traffic carry the global count past one UTC day",
    () =>
      Effect.gen(function* steadyTraffic() {
        const { auth, sent } = makeAuth(
          LOCAL_HOSTS,
          migratedDatabase(),
          () => true,
          7
        );

        const statuses: number[] = [];

        for (const index of Array.from({ length: 21 }, (_, at) => at)) {
          travelTo(T0 + index * 8 * 60 * MINUTE);
          statuses.push(
            (yield* requestLink(
              auth,
              `member${index}@example.com`,
              `2001:db8:${index}::1`
            )).status
          );
        }

        expect(statuses).toStrictEqual(Array.from({ length: 21 }, () => 200));
        expect(sent).toHaveLength(21);
      })
  );

  it.effect.each([
    "E_DAILY_LIMIT_EXCEEDED",
    "E_RATE_LIMIT_EXCEEDED",
    "E_INTERNAL_SERVER_ERROR",
    "Unknown",
  ])(
    "global send claims distinguish refusal from uncertain acceptance for %s",
    (code) =>
      Effect.gen(function* globalRefund() {
        travelTo(T0);
        let unavailable = true;

        const { auth, sent } = makeAuth(
          LOCAL_HOSTS,
          migratedDatabase(),
          () =>
            unavailable
              ? new Error("provider failed", { cause: { code } })
              : true,
          1
        );

        expect(
          (yield* requestLink(auth, "first@example.com", "2001:db8:1::1"))
            .status
        ).toBe(500);
        unavailable = false;

        const recovered = yield* requestLink(
          auth,
          "second@example.com",
          "2001:db8:2::1"
        );

        const refused =
          code === "E_DAILY_LIMIT_EXCEEDED" || code === "E_RATE_LIMIT_EXCEEDED";

        expect(recovered.status).toBe(refused ? 200 : 429);
        expect(sent).toHaveLength(refused ? 1 : 0);
      })
  );

  it.effect(
    "counts every Gmail spelling of one inbox together, and only Gmail's",
    () =>
      Effect.gen(function* gmailAliases() {
        travelTo(T0);

        const { auth, sent } = makeAuth();
        const statuses: number[] = [];

        for (const [index, email] of [
          "victim.name@gmail.com",
          "VictimName@googlemail.com",
          "v.i.c.t.i.m.n.a.m.e+x@GoogleMail.com",
          "victimname@gmail.com",
        ].entries()) {
          statuses.push(
            (yield* requestLink(auth, email, `2001:db8:${index}::1`)).status
          );
        }

        const elsewhere: number[] = [];

        for (const [index, email] of [
          "victim.name@example.com",
          "victimname@example.com",
          "vic.tim.name@example.com",
          "v.i.c.t.i.m.n.a.m.e@example.com",
        ].entries()) {
          elsewhere.push(
            (yield* requestLink(auth, email, `2001:db8:a${index}::1`)).status
          );
        }

        expect(statuses).toStrictEqual([200, 200, 200, 429]);
        expect(elsewhere).toStrictEqual([200, 200, 200, 200]);
        expect(sent).toHaveLength(7);
      })
  );

  it.effect(
    "counts every +tag spelling of an inbox together on any domain, so throwaway tags share one budget",
    () =>
      Effect.gen(function* plusTagsEverywhere() {
        travelTo(T0);

        const { auth, sent } = makeAuth();
        const statuses: number[] = [];

        for (const [index, email] of [
          "victim+1@corp.com",
          "victim+2@corp.com",
          "Victim+news@Corp.com",
          "victim@corp.com",
        ].entries()) {
          statuses.push(
            (yield* requestLink(auth, email, `2001:db8:${index}::1`)).status
          );
        }

        expect(statuses).toStrictEqual([200, 200, 200, 429]);
        expect(sent.map(({ email }) => email)).toStrictEqual([
          "victim+1@corp.com",
          "victim+2@corp.com",
          "Victim+news@Corp.com",
        ]);
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

  it.effect(
    "spends nothing from an inbox's budget on an address better-auth refuses",
    () =>
      Effect.gen(function* malformedSpellings() {
        const { auth, sent } = makeAuth();
        const refused: number[] = [];

        for (const [index, email] of [
          " victim@example.com",
          "victim@example.com ",
          "VICTIM@example.com\t",
          "victim+(@example.com",
        ].entries()) {
          refused.push(
            (yield* requestLink(auth, email, `2001:db8:${index}::1`)).status
          );
        }

        const real = yield* requestLink(
          auth,
          "victim@example.com",
          "2001:db8:9::1"
        );

        expect(refused).toStrictEqual([400, 400, 400, 400]);
        expect(real.status).toBe(200);
        expect(sent.map(({ email }) => email)).toStrictEqual([
          "victim@example.com",
        ]);
      })
  );

  it.effect(
    "refuses an address longer than any inbox can have, before it counts or sends",
    () =>
      Effect.gen(function* overlong() {
        const { auth, database, sent } = makeAuth();
        const email = `${"a".repeat(64)}@${["b", "c", "d"].map((label) => label.repeat(63)).join(".")}.com`;

        const response = yield* requestLink(auth, email);

        expect(response.status).toBe(400);
        expect(sent).toHaveLength(0);
        expect(
          database
            .prepare(
              "SELECT key FROM \"rateLimit\" WHERE key LIKE 'magic-link-%'"
            )
            .all()
        ).toStrictEqual([]);
      })
  );

  it.effect("gives an inbox its send back when the mailer fails", () =>
    Effect.gen(function* refund() {
      let up = false;

      const { auth, sent } = makeAuth(
        LOCAL_HOSTS,
        migratedDatabase(),
        () => up
      );

      const failed = yield* statusOf(
        requestLink(auth, "victim@example.com", "2001:db8:0::1")
      );

      up = true;

      const statuses: number[] = [];

      for (const index of [1, 2, 3, 4]) {
        statuses.push(
          (yield* requestLink(
            auth,
            "victim@example.com",
            `2001:db8:${index}::1`
          )).status
        );
      }

      expect(failed).toBe(500);
      expect(statuses).toStrictEqual([200, 200, 200, 429]);
      expect(sent).toHaveLength(EMAIL_SEND_LIMIT.max);
    })
  );

  it.effect.each([
    ["an unexplained failure", () => false],
    [
      "a suppressed recipient",
      () => cloudflareSendError("E_RECIPIENT_SUPPRESSED"),
    ],
    [
      "a recipient server rejection",
      () => cloudflareSendError("E_DELIVERY_FAILED"),
    ],
  ] satisfies [string, Mailer][])(
    "stops calling the mailer after 6 tries at one address on %s",
    ([, fails]) =>
      Effect.gen(function* failingMailer() {
        let tries = 0;

        const { auth } = makeAuth(LOCAL_HOSTS, migratedDatabase(), () => {
          tries += 1;

          return fails();
        });

        const statuses: number[] = [];

        for (const index of [0, 1, 2, 3, 4, 5, 6]) {
          statuses.push(
            yield* statusOf(
              requestLink(auth, "victim@example.com", `2001:db8:${index}::1`)
            )
          );
        }

        expect(statuses).toStrictEqual([500, 500, 500, 500, 500, 500, 429]);
        expect(tries).toBe(6);
      })
  );

  it.effect.each([
    "E_DAILY_LIMIT_EXCEEDED",
    "E_RATE_LIMIT_EXCEEDED",
    "E_INTERNAL_SERVER_ERROR",
  ])("spends no attempt when the mail provider fails with %s", (code) =>
    Effect.gen(function* providerOutage() {
      let down = true;

      const { auth, sent } = makeAuth(LOCAL_HOSTS, migratedDatabase(), () =>
        down ? cloudflareSendError(code) : true
      );

      const outage: number[] = [];

      for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
        outage.push(
          yield* statusOf(
            requestLink(auth, "victim@example.com", `2001:db8:${index}::1`)
          )
        );
      }

      down = false;

      const recovered = yield* requestLink(
        auth,
        "victim@example.com",
        "2001:db8:9::1"
      );

      expect(outage).toStrictEqual([500, 500, 500, 500, 500, 500, 500, 500]);
      expect(recovered.status).toBe(200);
      expect(sent).toHaveLength(1);
    })
  );

  it.effect(
    "mails a 254-character address and refuses a 255-character one",
    () =>
      Effect.gen(function* lengthBoundary() {
        const { auth, sent } = makeAuth();
        const longest = longAddress(57);
        const tooLong = longAddress(58);

        const accepted = yield* requestLink(auth, longest, "2001:db8:1::1");
        const refused = yield* requestLink(auth, tooLong, "2001:db8:2::1");

        expect([longest.length, tooLong.length]).toStrictEqual([254, 255]);
        expect([accepted.status, refused.status]).toStrictEqual([200, 400]);
        expect(sent.map(({ email }) => email)).toStrictEqual([longest]);
      })
  );

  it.effect(
    "never lets a refund push an address's count below zero after the window reset under it",
    () =>
      Effect.gen(function* lateRefund() {
        const database = migratedDatabase();
        let calls = 0;

        const { auth, sent } = makeAuth(LOCAL_HOSTS, database, () => {
          calls += 1;

          if (calls === 1) {
            database
              .prepare(
                "UPDATE \"rateLimit\" SET count = 0 WHERE key = 'magic-link-email:victim@example.com'"
              )
              .run();
          }

          return calls > 1;
        });

        const late = yield* statusOf(
          requestLink(auth, "victim@example.com", "2001:db8:1::1")
        );

        const after: number[] = [];

        for (const index of [3, 4, 5, 6]) {
          after.push(
            (yield* requestLink(
              auth,
              "victim@example.com",
              `2001:db8:${index}::1`
            )).status
          );
        }

        expect(late).toBe(500);
        expect(after).toStrictEqual([200, 200, 200, 429]);
        expect(sent).toHaveLength(3);
      })
  );

  it.effect(
    "counts a first request that loses the insert race for a new address against the row that won",
    () =>
      Effect.gen(function* firstInsertRace() {
        travelTo(T0);

        const database = losingFirstCountRace();
        const { auth, sent } = makeAuth(LOCAL_HOSTS, database);

        const status = yield* statusOf(
          requestLink(auth, "victim@example.com", "2001:db8:1::1")
        );

        const counts = database
          .prepare(
            "SELECT key, count, id = 'racer' AS racer FROM \"rateLimit\" WHERE key LIKE 'magic-link-%' ORDER BY key"
          )
          .all()
          .map(({ count, key, racer }) => ({ count, key, racer }));

        expect(status).toBe(200);
        expect(sent).toHaveLength(1);
        expect(counts).toStrictEqual([
          { count: 2, key: RACED_KEY, racer: 1 },
          {
            count: 1,
            key: "magic-link-client:2026-10-17:2001:0db8:0001:0000:0000:0000:0000:0000",
            racer: 0,
          },
          { count: 1, key: "magic-link-email:victim@example.com", racer: 0 },
          { count: 1, key: "magic-link-global:2026-10-17", racer: 0 },
          {
            count: 1,
            key: "magic-link-inbox:2026-10-17:victim@example.com",
            racer: 0,
          },
          { count: 1, key: "magic-link-new:2026-10-17", racer: 0 },
        ]);
      })
  );

  it.effect(
    "answers 500, not too many links, when the database refuses an address's first count",
    () =>
      Effect.gen(function* firstInsertFails() {
        const { auth, sent } = makeAuth(LOCAL_HOSTS, refusingLimiterInserts());

        const status = yield* statusOf(
          requestLink(auth, "victim@example.com", "2001:db8:1::1")
        );

        expect(status).toBe(500);
        expect(sent).toHaveLength(0);
      })
  );
});

const Group = Schema.Int.check(
  Schema.isBetween({ maximum: 0xff_ff, minimum: 0 })
);

const hex = (group: number) => group.toString(16);

const fillClientBudget = (
  auth: Auth,
  ip: string,
  prefix: string,
  forwardedFor: (index: number) => string | undefined = () => {}
) =>
  Effect.forEach(
    Array.from({ length: CLIENT_DAILY_SEND_LIMIT }, (_, index) => index),
    (index) => {
      travelTo(T0 + index * 2 * MINUTE);

      const spoof = forwardedFor(index);

      return requestLink(
        auth,
        `${prefix}${index}@example.com`,
        ip,
        spoof === undefined ? {} : { forwardedFor: spoof }
      ).pipe(Effect.map(({ status }) => status));
    }
  );

describe("per-client daily send limit", () => {
  it.effect.prop(
    `sends at most ${CLIENT_DAILY_SEND_LIMIT} links a UTC day to one IPv6 /64, whatever its interface ids`,
    {
      network: Schema.Tuple([Group, Group]),
      suffix: Schema.Tuple([Group, Group, Group, Group]),
    },
    ({ network: [high, low], suffix: [a, b, c, d] }) =>
      Effect.gen(function* perNetwork() {
        travelTo(T0);

        const { auth, sent } = makeAuth();
        const prefix = `2001:db8:${hex(high)}:${hex(low)}`;
        const neighbour = `2001:db8:${hex(high)}:${hex((low + 1) % 0x1_00_00)}::1`;
        const statuses: number[] = [];

        for (const index of Array.from(
          { length: CLIENT_DAILY_SEND_LIMIT + 1 },
          (_, at) => at
        )) {
          travelTo(T0 + index * 2 * MINUTE);
          statuses.push(
            (yield* requestLink(
              auth,
              `member${index}@example.com`,
              `${prefix}:${hex((a + index) % 0x1_00_00)}:${hex(b)}:${hex(c)}:${hex(d)}`
            )).status
          );
        }

        const refusedAddress = yield* requestLink(
          auth,
          `member${CLIENT_DAILY_SEND_LIMIT}@example.com`,
          neighbour
        );

        travelTo(T0 + 12 * 60 * MINUTE);

        const nextDay = yield* requestLink(
          auth,
          "tomorrow@example.com",
          `${prefix}::1`
        );

        expect(statuses).toStrictEqual([
          ...Array.from({ length: CLIENT_DAILY_SEND_LIMIT }, () => 200),
          429,
        ]);
        expect(refusedAddress.status).toBe(200);
        expect(nextDay.status).toBe(200);
        expect(sent).toHaveLength(CLIENT_DAILY_SEND_LIMIT + 2);
      }),
    { arbitrary: { runs: 8 }, timeout: 60_000 }
  );

  it.effect.prop(
    "counts an IPv4 client on its own and never against another",
    { last: Schema.Int.check(Schema.isBetween({ maximum: 254, minimum: 1 })) },
    ({ last }) =>
      Effect.gen(function* perAddress() {
        travelTo(T0);

        const { auth } = makeAuth();
        const statuses: number[] = [];

        for (const index of Array.from(
          { length: CLIENT_DAILY_SEND_LIMIT + 1 },
          (_, at) => at
        )) {
          travelTo(T0 + index * 2 * MINUTE);
          statuses.push(
            (yield* requestLink(
              auth,
              `member${index}@example.com`,
              `198.51.100.${last}`
            )).status
          );
        }

        const other = yield* requestLink(
          auth,
          "other@example.com",
          `198.51.100.${last === 254 ? 1 : last + 1}`
        );

        expect(statuses.at(-1)).toBe(429);
        expect(statuses.filter((status) => status === 200)).toHaveLength(
          CLIENT_DAILY_SEND_LIMIT
        );
        expect(other.status).toBe(200);
      }),
    { arbitrary: { runs: 4 }, timeout: 60_000 }
  );

  it.effect(
    "gives a client its daily send back when the site-wide cap refuses it",
    () =>
      Effect.gen(function* globalRefusalRefundsClient() {
        travelTo(T0);

        const database = migratedDatabase();
        const capped = makeAuth(LOCAL_HOSTS, database, () => true, 1);

        yield* requestLink(capped.auth, "first@example.com", "2001:db8:1::1");

        const refused = yield* fillClientBudget(
          capped.auth,
          "198.51.100.20",
          "refused"
        );

        const open = makeAuth(LOCAL_HOSTS, database);

        travelTo(T0 + CLIENT_DAILY_SEND_LIMIT * 2 * MINUTE);

        const after = yield* requestLink(
          open.auth,
          "after@example.com",
          "198.51.100.20"
        );

        expect(refused).toStrictEqual(
          Array.from({ length: CLIENT_DAILY_SEND_LIMIT }, () => 429)
        );
        expect(after.status).toBe(200);
      })
  );

  it.effect(
    "gives a client its daily send back when Email Sending refuses the send",
    () =>
      Effect.gen(function* rejectedSendRefundsClient() {
        travelTo(T0);

        let refusing = true;

        const { auth, sent } = makeAuth(LOCAL_HOSTS, migratedDatabase(), () =>
          refusing ? cloudflareSendError("E_DAILY_LIMIT_EXCEEDED") : true
        );

        const failed = yield* fillClientBudget(auth, "198.51.100.21", "failed");

        refusing = false;
        travelTo(T0 + CLIENT_DAILY_SEND_LIMIT * 2 * MINUTE);

        const after = yield* requestLink(
          auth,
          "after@example.com",
          "198.51.100.21"
        );

        expect(failed).toStrictEqual(
          Array.from({ length: CLIENT_DAILY_SEND_LIMIT }, () => 500)
        );
        expect(after.status).toBe(200);
        expect(sent.map(({ email }) => email)).toStrictEqual([
          "after@example.com",
        ]);
      })
  );

  it.effect(
    "counts a client by cf-connecting-ip alone, whatever x-forwarded-for claims",
    () =>
      Effect.gen(function* spoofedForwardedFor() {
        travelTo(T0);

        const { auth, database } = makeAuth();

        const statuses = yield* fillClientBudget(
          auth,
          "198.51.100.22",
          "spoof",
          (index) => `192.0.2.${index + 1}`
        );

        travelTo(T0 + CLIENT_DAILY_SEND_LIMIT * 2 * MINUTE);

        const over = yield* requestLink(
          auth,
          "over@example.com",
          "198.51.100.22",
          { forwardedFor: "192.0.2.200" }
        );

        expect(statuses).toStrictEqual(
          Array.from({ length: CLIENT_DAILY_SEND_LIMIT }, () => 200)
        );
        expect(over.status).toBe(429);
        expect(
          database
            .prepare(
              "SELECT key FROM \"rateLimit\" WHERE key LIKE 'magic-link-client:%'"
            )
            .all()
            .map(({ key }) => String(key))
        ).toStrictEqual(["magic-link-client:2026-10-17:198.51.100.22"]);
      })
  );

  it.effect(
    "deletes a past day's client and site-wide counters once they are a day stale",
    () =>
      Effect.gen(function* prunesDayKeys() {
        travelTo(T0);

        const { auth, database } = makeAuth();

        yield* requestLink(auth, "ada@example.com");

        travelTo(T0 + 2 * 24 * 60 * MINUTE);

        yield* requestLink(auth, "bob@example.com");

        expect(
          database
            .prepare(
              "SELECT key FROM \"rateLimit\" WHERE key GLOB 'magic-link-*:20*' ORDER BY key"
            )
            .all()
            .map(({ key }) => String(key))
        ).toStrictEqual([
          "magic-link-client:2026-10-19:203.0.113.7",
          "magic-link-global:2026-10-19",
          "magic-link-inbox:2026-10-19:bob@example.com",
          "magic-link-new:2026-10-19",
        ]);
      })
  );
});

const signInOnce = (auth: Auth, sent: MagicLinkRequest[], email: string) =>
  Effect.gen(function* signIn() {
    yield* requestLink(auth, email, "192.0.2.200");

    return yield* call(auth, pathOf(sent.at(-1)?.url ?? ""), CONFIRM_FORM);
  });

const newAddressRequests = (
  auth: Auth,
  length: number,
  startAt = 0
): Effect.Effect<readonly number[]> =>
  Effect.forEach(
    Array.from({ length }, (_, index) => index + startAt),
    (index) =>
      requestLink(
        auth,
        `stranger${index}@example.com`,
        `198.51.${Math.floor(index / 250)}.${(index % 250) + 1}`
      ).pipe(Effect.map(({ status }) => status))
  );

describe("site-wide budget", () => {
  const LIMIT = 10;
  const NEW_SHARE = newAddressDailySendLimit(LIMIT);

  it.effect("sets aside most of the budget for existing members", () =>
    Effect.sync(() => {
      expect(newAddressDailySendLimit(900)).toBe(360);
      expect(NEW_SHARE).toBe(4);
    })
  );

  it.effect(
    "lets a member sign in after new addresses have spent their share",
    () =>
      Effect.gen(function* memberReserve() {
        travelTo(T0);

        const { auth, sent } = makeAuth(
          LOCAL_HOSTS,
          migratedDatabase(),
          () => true,
          LIMIT
        );

        yield* signInOnce(auth, sent, "member@example.com");

        const strangers = yield* newAddressRequests(auth, NEW_SHARE);

        travelTo(T0 + 16 * MINUTE);

        const member = yield* requestLink(
          auth,
          "member@example.com",
          "203.0.113.50"
        );

        expect(strangers).toStrictEqual([
          ...Array.from({ length: NEW_SHARE - 1 }, () => 200),
          429,
        ]);
        expect(member.status).toBe(200);
      })
  );

  it.effect("still stops every send at the overall cap", () =>
    Effect.gen(function* overallCap() {
      travelTo(T0);

      const { auth, sent } = makeAuth(
        LOCAL_HOSTS,
        migratedDatabase(),
        () => true,
        2
      );

      yield* signInOnce(auth, sent, "member@example.com");

      travelTo(T0 + 16 * MINUTE);

      yield* requestLink(auth, "member@example.com", "203.0.113.50");

      travelTo(T0 + 32 * MINUTE);

      const over = yield* requestLink(
        auth,
        "member@example.com",
        "203.0.113.51"
      );

      expect(over.status).toBe(429);
      expect(sent).toHaveLength(2);
    })
  );

  it.effect("treats an account with an unverified address as new", () =>
    Effect.gen(function* unverified() {
      travelTo(T0);

      const { auth, database } = makeAuth(
        LOCAL_HOSTS,
        migratedDatabase(),
        () => true,
        1
      );

      database
        .prepare(
          `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
           VALUES ('u1', '', 'unproven@example.com', 0, '2026-10-17', '2026-10-17')`
        )
        .run();

      yield* requestLink(auth, "stranger@example.com", "203.0.113.50");

      const refused = yield* requestLink(
        auth,
        "unproven@example.com",
        "203.0.113.51"
      );

      expect(refused.status).toBe(429);
    })
  );

  it.effect("gives back every daily count when the new share refuses", () =>
    Effect.gen(function* refundOnRefusal() {
      travelTo(T0);

      const { auth, database } = makeAuth(
        LOCAL_HOSTS,
        migratedDatabase(),
        () => true,
        1
      );

      yield* requestLink(auth, "first@example.com", "203.0.113.50");

      const refused = yield* requestLink(
        auth,
        "second@example.com",
        "203.0.113.51"
      );

      const counts = Object.fromEntries(
        database
          .prepare(
            "SELECT key, count FROM \"rateLimit\" WHERE key LIKE 'magic-link-%:2026-10-17%'"
          )
          .all()
          .map(({ count, key }) => [String(key), Number(count)])
      );

      expect(refused.status).toBe(429);
      expect(counts).toMatchObject({
        "magic-link-client:2026-10-17:203.0.113.50": 1,
        "magic-link-client:2026-10-17:203.0.113.51": 0,
        "magic-link-global:2026-10-17": 1,
        "magic-link-inbox:2026-10-17:second@example.com": 0,
        "magic-link-new:2026-10-17": 1,
      });
    })
  );
});

describe("per-inbox daily send limit", () => {
  it.effect.each(["a member", "a new address"])(
    `sends %s at most ${INBOX_DAILY_SEND_LIMIT} links a UTC day, so the answer never reveals which it is`,
    (kind) =>
      Effect.gen(function* inboxDay() {
        travelTo(T0);

        const { auth, sent } = makeAuth();
        const email = "someone@example.com";

        if (kind === "a member") {
          yield* signInOnce(auth, sent, "someone@example.com");
        }

        const asked = kind === "a member" ? 1 : 0;

        const statuses = yield* Effect.forEach(
          Array.from(
            { length: INBOX_DAILY_SEND_LIMIT + 1 - asked },
            (_, index) => index
          ),
          (index) => {
            travelTo(T0 + (index + 1) * 16 * MINUTE);

            return statusOf(
              requestLink(auth, email, `203.0.113.${index + 60}`)
            );
          }
        );

        expect(statuses).toStrictEqual([
          ...Array.from({ length: INBOX_DAILY_SEND_LIMIT - asked }, () => 200),
          429,
        ]);
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

describe("magic link verify", () => {
  it.effect.each([
    ["a cross-site", "cross-site"],
    ["a same-site", "same-site"],
    ["a none", "none"],
    ["an unlabelled", undefined],
  ])(
    "refuses %s verify without spending the link, so the viewer can still sign in",
    ([, fetchSite]) =>
      Effect.gen(function* loginCsrf() {
        const { auth, sent } = makeAuth();

        yield* requestLink(auth, "attacker@example.com");

        const link = pathOf(sent[0]?.url ?? "");
        const forged = yield* call(auth, link, { fetchSite });

        expect(forged.status).toBe(403);
        expect(cookieOf(forged)).not.toContain("session_token=");

        const own = yield* call(auth, link, { fetchSite: "same-origin" });

        expect(own.status).toBe(302);
        expect(cookieOf(own)).toContain("session_token=");
      })
  );

  it.effect("signs in from the confirm page's same-origin form", () =>
    Effect.gen(function* allowedVerify() {
      const { auth, sent } = makeAuth();

      yield* requestLink(auth, "ada@example.com");

      const verified = yield* call(auth, pathOf(sent[0]?.url ?? ""), {
        fetchSite: "same-origin",
      });

      expect(verified.status).toBe(302);
      expect(cookieOf(verified)).toContain("session_token=");
    })
  );
});

const previewPath = (token: string) =>
  `/api/auth/magic-link/preview?token=${token}`;

const textOf = (response: Response) =>
  Effect.promise(
    // @effect-diagnostics-next-line asyncFunction:off -- Response bodies are Promise-based.
    async () => await response.text()
  );

describe("magic link preview", () => {
  it.effect("names the account a live link belongs to and spends nothing", () =>
    Effect.gen(function* preview() {
      const { auth, database, sent } = makeAuth();

      yield* requestLink(auth, "Ada@example.com");

      const url = sent[0]?.url ?? "";

      const named = yield* call(auth, previewPath(tokenOf(url)), CONFIRM_FORM);

      expect(named.status).toBe(200);
      expect(named.headers.get("cache-control")).toContain("no-store");
      expect(cookieOf(named)).not.toContain("session_token=");
      expect(yield* textOf(named)).toBe('{"email":"Ada@example.com"}');
      expect(
        database.prepare('SELECT identifier FROM "verification"').all()
      ).toHaveLength(1);

      const verified = yield* call(auth, pathOf(url), CONFIRM_FORM);

      expect(verified.status).toBe(302);
      expect(cookieOf(verified)).toContain("session_token=");
    })
  );

  it.effect("tells a link holder nothing about an unknown token", () =>
    Effect.gen(function* unknown() {
      const { auth } = makeAuth();

      yield* requestLink(auth, "ada@example.com");

      const refused = yield* call(
        auth,
        previewPath("not-a-token"),
        CONFIRM_FORM
      );

      expect(refused.status).toBe(404);
      expect(yield* textOf(refused)).not.toContain("ada@");
    })
  );

  it.effect("names nobody for an expired link", () =>
    Effect.gen(function* expired() {
      travelTo(T0);

      const { auth, sent } = makeAuth();

      yield* requestLink(auth, "ada@example.com");

      travelTo(T0 + (MAGIC_LINK_TTL_MINUTES + 1) * MINUTE);

      const refused = yield* call(
        auth,
        previewPath(tokenOf(sent[0]?.url ?? "")),
        CONFIRM_FORM
      );

      expect(refused.status).toBe(404);
      expect(yield* textOf(refused)).not.toContain("ada@");
    })
  );

  it.effect("names nobody for a link already used", () =>
    Effect.gen(function* used() {
      const { auth, sent } = makeAuth();

      yield* requestLink(auth, "ada@example.com");

      const url = sent[0]?.url ?? "";

      yield* call(auth, pathOf(url), CONFIRM_FORM);

      const refused = yield* call(
        auth,
        previewPath(tokenOf(url)),
        CONFIRM_FORM
      );

      expect(refused.status).toBe(404);
      expect(yield* textOf(refused)).not.toContain("ada@");
    })
  );

  it.effect.each([
    ["a cross-site", "cross-site"],
    ["a same-site", "same-site"],
    ["an unlabelled", undefined],
  ])(
    "refuses %s preview, so another page cannot read the name",
    ([, fetchSite]) =>
      Effect.gen(function* crossSite() {
        const { auth, sent } = makeAuth();

        yield* requestLink(auth, "ada@example.com");

        const refused = yield* call(
          auth,
          previewPath(tokenOf(sent[0]?.url ?? "")),
          { fetchSite }
        );

        expect(refused.status).toBe(403);
        expect(yield* textOf(refused)).not.toContain("ada@");
      })
  );

  it.effect("limits a client to 10 previews a minute", () =>
    Effect.gen(function* limited() {
      const { auth, sent } = makeAuth();

      yield* requestLink(auth, "ada@example.com");

      const path = previewPath(tokenOf(sent[0]?.url ?? ""));

      const statuses = yield* Effect.forEach(Array.from({ length: 11 }), () =>
        statusOf(call(auth, path, CONFIRM_FORM))
      );

      expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(
        true
      );
      expect(statuses[10]).toBe(429);
    })
  );
});

describe("stage hosts", () => {
  const PREVIEW = "https://jobs-verify-x.acct.workers.dev";

  const previewHosts = siteHostsOf("verify-x", {
    localHosts: [],
    workersSubdomain: Option.some("acct"),
  });

  const PROD = "https://jobs.rowlandekemezie.com";

  it.effect("emails a preview stage's own workers.dev link", () =>
    Effect.gen(function* previewLink() {
      const { auth, sent } = makeAuth(previewHosts);

      const response = yield* requestLink(auth, "ada@example.com", undefined, {
        at: PREVIEW,
      });

      expect(response.status).toBe(200);
      expect(sent[0]?.url).toMatch(
        /^https:\/\/jobs-verify-x\.acct\.workers\.dev\/api\/auth\/magic-link\/verify\?/u
      );
    })
  );

  it.effect(
    "refuses the same Worker name on another account's workers.dev",
    () =>
      Effect.gen(function* otherAccount() {
        const { auth, sent } = makeAuth(previewHosts);

        const status = yield* statusOf(
          requestLink(auth, "ada@example.com", undefined, {
            at: "https://jobs-verify-x.attacker.workers.dev",
          })
        );

        expect(status).not.toBe(200);
        expect(sent).toHaveLength(0);
      })
  );

  it.effect("resolves a preview stage's session for an /rpc request", () =>
    Effect.gen(function* previewSession() {
      const { auth, sent } = makeAuth(previewHosts);

      yield* requestLink(auth, "ada@example.com", undefined, { at: PREVIEW });

      const verified = yield* call(auth, pathOf(sent[0]?.url ?? ""), {
        ...CONFIRM_FORM,
        at: PREVIEW,
      });

      const store = makeAccountStore(
        (headers) =>
          Effect.promise(
            // @effect-diagnostics-next-line asyncFunction:off -- better-auth's api is Promise-based.
            async () => await auth.api.getSession({ headers })
          ),
        { socialProviders: [] }
      );

      const viewer = yield* viewerOfRequest(store, {
        cookie: cookieOf(verified),
        host: new URL(PREVIEW).host,
        origin: PREVIEW,
        "sec-fetch-site": "same-origin",
      });

      expect(viewer._tag).toBe("Member");
    })
  );

  it.effect("never trusts the prod site from a preview stage", () =>
    Effect.gen(function* previewDistrustsProd() {
      const { auth, sent } = makeAuth(previewHosts);

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
        const { auth, sent } = makeAuth(
          siteHostsOf("prod", {
            localHosts: ["localhost:*"],
            workersSubdomain: Option.some("acct"),
          })
        );

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

const trackerOn = (database: DatabaseSync) =>
  trackerStoreLayer.pipe(
    Layer.provide(
      Layer.succeed(
        SqlExecutor,
        SqlExecutor.of({
          all: (operation, sql, row) =>
            Schema.decodeEffect(Schema.Array(row))(
              database.prepare(sql.sql).all(...sql.params)
            ).pipe(
              Effect.mapError(
                (failure) =>
                  new JobStoreUnavailable({
                    message: failure.message,
                    operation,
                  })
              )
            ),
          batch: (_operation, statements) =>
            Effect.sync(() =>
              statements.map((sql) => ({
                changes: Number(
                  database.prepare(sql.sql).run(...sql.params).changes
                ),
              }))
            ),
        })
      )
    )
  );

describe("tracker writes over /rpc", () => {
  const save = {
    jobId: "greenhouse:acme/1",
    snapshot: {
      company: "Acme",
      location: "Remote",
      title: "Engineering Manager",
      url: "https://boards.example/acme/1",
    },
    stage: "Saved" as const,
  };

  it.effect.each([
    ["a cross-site fetch", { "sec-fetch-site": "cross-site" }, 403, 0],
    ["a same-site sibling", { "sec-fetch-site": "same-site" }, 403, 0],
    ["a foreign Origin", { origin: "https://evil.example" }, 403, 0],
    ["a same-origin fetch", { "sec-fetch-site": "same-origin" }, 200, 1],
  ] as const)(
    "a member's trackJob from %s answers %d and saves %d rows",
    ([, extra, status, rows]) =>
      Effect.gen(function* crossSiteTrack() {
        const { auth, database, sent } = makeAuth();

        yield* requestLink(auth, "ada@example.com");

        const verified = yield* call(
          auth,
          pathOf(sent[0]?.url ?? ""),
          CONFIRM_FORM
        );

        const store = makeAccountStore(
          (headers) =>
            Effect.promise(
              // @effect-diagnostics-next-line asyncFunction:off -- better-auth's api is Promise-based.
              async () => await auth.api.getSession({ headers })
            ),
          { socialProviders: [] }
        );

        const response = yield* respondAsViewer(
          store,
          {
            cookie: cookieOf(verified),
            host: new URL(ORIGIN).host,
            origin: ORIGIN,
            ...extra,
          },
          (viewer) =>
            trackJob
              .handler(save)
              .pipe(
                Effect.provideService(CurrentViewer, viewer),
                Effect.provide(trackerOn(database)),
                Effect.as(HttpServerResponse.empty({ status: 200 }))
              )
        );

        expect(response.status).toBe(status);
        expect(
          database.prepare("SELECT job_id FROM tracked_jobs").all()
        ).toHaveLength(rows);
      })
  );
});

describe("per-request database cost", () => {
  it.effect(
    "resolves a signed-in session from a fresh auth instance in one query, without reading the schema",
    () =>
      Effect.gen(function* oneQuery() {
        const database = migrate(new RecordingDatabase(":memory:"));
        const { auth, sent } = makeAuth(LOCAL_HOSTS, database);

        yield* requestLink(auth, "ada@example.com");

        const verified = yield* call(
          auth,
          pathOf(sent[0]?.url ?? ""),
          CONFIRM_FORM
        );

        database.statements.length = 0;

        const perRequest = makeAuth(LOCAL_HOSTS, database).auth;

        const session = yield* Effect.promise(
          // @effect-diagnostics-next-line asyncFunction:off -- better-auth's api is Promise-based.
          async () =>
            await perRequest.api.getSession({
              headers: new Headers({ cookie: cookieOf(verified) }),
              query: { disableRefresh: true },
            })
        );

        expect(session?.user.email).toBe("ada@example.com");
        expect(database.statements).toHaveLength(1);
      })
  );

  it.effect("answers get-session without a cookie from no query at all", () =>
    Effect.gen(function* noQuery() {
      const database = migrate(new RecordingDatabase(":memory:"));
      const { auth } = makeAuth(LOCAL_HOSTS, database);

      const response = yield* call(auth, "/api/auth/get-session");

      const body = yield* Effect.promise(
        // @effect-diagnostics-next-line asyncFunction:off -- Response.json is Promise-based.
        async () => await response.json()
      );

      expect(response.status).toBe(200);
      expect(body).toBeNull();
      expect(database.statements).toStrictEqual([]);
    })
  );
});
