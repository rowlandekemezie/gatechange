import { describe, expect, it } from "@effect/vitest";
import { Account, Viewer } from "@rat-stack/core";
import { ConfigProvider, Effect, Redacted, Schema } from "effect";

import {
  authSecret,
  makeAccountStore,
  SESSION_COOKIE,
  viewerOfCookie,
} from "../src/index.js";
import type { SessionUser } from "../src/index.js";

const ada: SessionUser = { email: "ada@example.com", id: "user_ada", name: "" };

const adaAccount = Schema.decodeSync(Account)(ada);

const LIVE = `__Secure-${SESSION_COOKIE}=live`;

const storeWith = (lookup: (cookie: string) => Effect.Effect<unknown>) =>
  makeAccountStore(
    (cookie) =>
      lookup(cookie).pipe(
        Effect.map((found) => (found === null ? null : { user: ada }))
      ),
    { socialProviders: [] }
  );

const sessions = storeWith((cookie) =>
  Effect.succeed(cookie === LIVE ? ada : null)
);

describe("viewerOfCookie", () => {
  it.effect("makes a live session cookie a member", () =>
    Effect.gen(function* member() {
      expect(yield* viewerOfCookie(sessions, LIVE)).toStrictEqual(
        Viewer.Member({ account: adaAccount })
      );
    })
  );

  it.effect.each([
    ["no cookie header", undefined],
    ["an empty cookie header", ""],
    ["unrelated cookies", "theme=dark"],
    ["a revoked session cookie", `__Secure-${SESSION_COOKIE}=revoked`],
  ])("makes %s anonymous", ([, cookie]) =>
    Effect.gen(function* anonymous() {
      expect(yield* viewerOfCookie(sessions, cookie)).toStrictEqual(
        Viewer.Anonymous()
      );
    })
  );

  it.effect("serves an anonymous viewer when the account store is down", () =>
    Effect.gen(function* storeDown() {
      const down = storeWith(() => Effect.die("D1 timed out"));

      expect(yield* viewerOfCookie(down, LIVE)).toStrictEqual(
        Viewer.Anonymous()
      );
    })
  );
});

const secretFrom = (env: Record<string, string>) =>
  authSecret.parse(ConfigProvider.fromUnknown(env));

const refusedSecrets: readonly (readonly [string, Record<string, string>])[] = [
  ["absent", {}],
  ["empty", { BETTER_AUTH_SECRET: "" }],
  ["31 characters", { BETTER_AUTH_SECRET: "x".repeat(31) }],
];

describe("authSecret", () => {
  it.effect.each(refusedSecrets)("refuses a secret that is %s", ([, env]) =>
    Effect.gen(function* refused() {
      expect((yield* Effect.exit(secretFrom(env)))._tag).toBe("Failure");
    })
  );

  it.effect("accepts a 32 character secret", () =>
    Effect.gen(function* accepted() {
      const secret = yield* secretFrom({ BETTER_AUTH_SECRET: "x".repeat(32) });

      expect(Redacted.value(secret)).toBe("x".repeat(32));
    })
  );
});
