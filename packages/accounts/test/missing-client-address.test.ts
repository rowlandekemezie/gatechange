import "./fixtures/production-env.js";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test applies the checked-in migration SQL to a throwaway database before any Effect runs.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { format } from "node:util";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { jobStoreMigrationDirectory } from "@rat-stack/job-store";
import { betterAuth } from "better-auth";
import { Effect, Option } from "effect";
import { vi } from "vitest";

import { CLIENT_DAILY_SEND_LIMIT } from "../src/email-send-limit.js";
import { authOptions } from "../src/index.js";
import type { MagicLinkRequest } from "../src/index.js";

const ORIGIN = "http://localhost:1337";

const T0 = Date.UTC(2026, 9, 17, 12);

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

const makeAuth = () => {
  const database = migratedDatabase();
  const sent: MagicLinkRequest[] = [];

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

const requestLink = (
  auth: ReturnType<typeof makeAuth>["auth"],
  email: string,
  forwardedFor: string
) =>
  Effect.promise(
    // @effect-diagnostics-next-line asyncFunction:off -- better-auth's handler is Promise-based.
    async () =>
      await auth.handler(
        new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
          body: JSON.stringify({ callbackURL: "/account", email }),
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            "x-forwarded-for": forwardedFor,
          },
          method: "POST",
        })
      )
  ).pipe(Effect.map(({ status }) => status));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a sign-in request without cf-connecting-ip", () => {
  it.effect(
    "shares one daily client bucket with every other such request, whatever x-forwarded-for claims, and warns each time",
    () =>
      Effect.gen(function* unknownBucket() {
        vi.useFakeTimers({ toFake: ["Date"] });

        const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { auth, database, sent } = makeAuth();

        const statuses = yield* Effect.forEach(
          Array.from(
            { length: CLIENT_DAILY_SEND_LIMIT + 1 },
            (_, index) => index
          ),
          (index) => {
            vi.setSystemTime(T0 + index * 2 * MINUTE);

            return requestLink(
              auth,
              `caller${index}@example.com`,
              `192.0.2.${index + 1}`
            );
          }
        );

        expect(statuses).toStrictEqual([
          ...Array.from({ length: CLIENT_DAILY_SEND_LIMIT }, () => 200),
          429,
        ]);
        expect(sent).toHaveLength(CLIENT_DAILY_SEND_LIMIT);
        expect(
          database
            .prepare(
              "SELECT key, count FROM \"rateLimit\" WHERE key LIKE 'magic-link-client:%'"
            )
            .all()
            .map(({ count, key }) => [String(key), Number(count)])
        ).toStrictEqual([
          ["magic-link-client:2026-10-17:unknown", CLIENT_DAILY_SEND_LIMIT],
        ]);
        expect(
          warnLog.mock.calls.filter((args) =>
            format(...args).includes("no client address")
          )
        ).toHaveLength(CLIENT_DAILY_SEND_LIMIT + 1);
      })
  );
});
