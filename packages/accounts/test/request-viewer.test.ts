import { describe, expect, it } from "@effect/vitest";
import { Account, Viewer } from "@rat-stack/core";
import type { RequestHeaders } from "@rat-stack/core";
import { ConfigProvider, Effect, Redacted, Schema } from "effect";

import {
  authSecret,
  CrossSiteRequest,
  makeAccountStore,
  SESSION_COOKIE,
  viewerOfRequest,
} from "../src/index.js";
import type { SessionUser } from "../src/index.js";

const ada: SessionUser = { email: "ada@example.com", id: "user_ada", name: "" };

const adaAccount = Schema.decodeSync(Account)(ada);

const LIVE = `__Secure-${SESSION_COOKIE}=live`;

const SITE = "gatechange.dev";

const storeWith = (lookup: (cookie: string) => Effect.Effect<unknown>) =>
  makeAccountStore(
    (headers) =>
      lookup(headers.get("cookie") ?? "").pipe(
        Effect.map((found) => (found === null ? null : { user: ada }))
      ),
    { socialProviders: [] }
  );

const sessions = storeWith((cookie) =>
  Effect.succeed(cookie === LIVE ? ada : null)
);

const member = Viewer.Member({ account: adaAccount });

describe("viewerOfRequest", () => {
  it.effect("makes a live session cookie a member", () =>
    Effect.gen(function* liveMember() {
      expect(yield* viewerOfRequest(sessions, { cookie: LIVE })).toStrictEqual(
        member
      );
    })
  );

  it.effect.each<readonly [string, RequestHeaders]>([
    ["no cookie header", {}],
    ["an empty cookie header", { cookie: "" }],
    ["unrelated cookies", { cookie: "theme=dark" }],
    [
      "a revoked session cookie",
      { cookie: `__Secure-${SESSION_COOKIE}=revoked` },
    ],
  ])("makes %s anonymous", ([, headers]) =>
    Effect.gen(function* anonymous() {
      expect(yield* viewerOfRequest(sessions, headers)).toStrictEqual(
        Viewer.Anonymous()
      );
    })
  );

  it.effect("serves an anonymous viewer when the account store is down", () =>
    Effect.gen(function* storeDown() {
      const down = storeWith(() => Effect.die("D1 timed out"));

      expect(yield* viewerOfRequest(down, { cookie: LIVE })).toStrictEqual(
        Viewer.Anonymous()
      );
    })
  );
});

const refusedRequests: readonly (readonly [string, RequestHeaders])[] = [
  ["a cross-site fetch", { "sec-fetch-site": "cross-site" }],
  ["a same-site sibling fetch", { "sec-fetch-site": "same-site" }],
  [
    "another origin, from a browser without fetch metadata",
    { host: SITE, origin: "https://evil.example" },
  ],
  ["an opaque origin", { host: SITE, origin: "null" }],
];

const allowedRequests: readonly (readonly [string, RequestHeaders])[] = [
  [
    "a same-origin fetch",
    { host: SITE, origin: `https://${SITE}`, "sec-fetch-site": "same-origin" },
  ],
  ["a request with no browser headers", {}],
  [
    "the site's own origin, without fetch metadata",
    { host: SITE, origin: `https://${SITE}` },
  ],
];

describe("cross-site /rpc requests", () => {
  it.effect.each(refusedRequests)(
    "refuses %s that carries the session cookie",
    ([, headers]) =>
      Effect.gen(function* refused() {
        const failure = yield* Effect.flip(
          viewerOfRequest(sessions, { ...headers, cookie: LIVE })
        );

        expect(failure).toBeInstanceOf(CrossSiteRequest);
      })
  );

  it.effect.each(refusedRequests)(
    "serves %s without a session cookie as anonymous",
    ([, headers]) =>
      Effect.gen(function* anonymousCrossSite() {
        expect(yield* viewerOfRequest(sessions, headers)).toStrictEqual(
          Viewer.Anonymous()
        );
      })
  );

  it.effect.each(allowedRequests)(
    "serves %s with the session as a member",
    ([, headers]) =>
      Effect.gen(function* allowed() {
        expect(
          yield* viewerOfRequest(sessions, { ...headers, cookie: LIVE })
        ).toStrictEqual(member);
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
