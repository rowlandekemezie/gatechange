import { describe, expect, it } from "@effect/vitest";
import { Account, AccountStoreUnavailable, Viewer } from "@rat-stack/core";
import { Effect, Schema } from "effect";

import { makeAccountStore, SESSION_COOKIE } from "../src/index.js";
import type { SessionUser } from "../src/index.js";

const options = { socialProviders: [] };

const ada: SessionUser = { email: "ada@example.com", id: "user_ada", name: "" };

const adaAccount = Schema.decodeSync(Account)(ada);

const counting = (result: { readonly user: SessionUser } | null) => {
  const seen: (string | null)[] = [];

  const store = makeAccountStore((headers) => {
    seen.push(headers.get("cookie"));

    return Effect.succeed(result);
  }, options);

  return { seen, store };
};

describe("makeAccountStore", () => {
  it.effect(
    "skips the session lookup when the request has no session cookie",
    () =>
      Effect.gen(function* noCookie() {
        const { seen, store } = counting({ user: ada });

        expect(yield* store.viewerOf({})).toStrictEqual(Viewer.Anonymous());
        expect(yield* store.viewerOf({ cookie: "theme=dark" })).toStrictEqual(
          Viewer.Anonymous()
        );
        expect(seen).toStrictEqual([]);
      })
  );

  it.effect("treats a cookie with no live session as anonymous", () =>
    Effect.gen(function* expired() {
      const { seen, store } = counting(null);
      const cookie = `${SESSION_COOKIE}=stale`;

      expect(yield* store.viewerOf({ cookie })).toStrictEqual(
        Viewer.Anonymous()
      );
      expect(seen).toStrictEqual([cookie]);
    })
  );

  it.effect(
    "hands the lookup the request's host, so auth can resolve a preview stage's address",
    () =>
      Effect.gen(function* forwardsHost() {
        const hosts: (string | null)[] = [];

        const store = makeAccountStore((headers) => {
          hosts.push(headers.get("host"));

          return Effect.succeed({ user: ada });
        }, options);

        yield* store.viewerOf({
          cookie: `${SESSION_COOKIE}=abc`,
          host: "jobs-verify-x.acct.workers.dev",
        });

        expect(hosts).toStrictEqual(["jobs-verify-x.acct.workers.dev"]);
      })
  );

  it.effect("turns a live session into a member with that account", () =>
    Effect.gen(function* live() {
      const { store } = counting({ user: ada });

      expect(
        yield* store.viewerOf({ cookie: `__Secure-${SESSION_COOKIE}=abc` })
      ).toStrictEqual(Viewer.Member({ account: adaAccount }));
    })
  );

  it.effect("reports a failed lookup as AccountStoreUnavailable", () =>
    Effect.gen(function* down() {
      const store = makeAccountStore(
        () => Effect.fail("D1 timed out"),
        options
      );

      const failure = yield* Effect.flip(
        store.viewerOf({ cookie: `${SESSION_COOKIE}=abc` })
      );

      expect(failure).toBeInstanceOf(AccountStoreUnavailable);
      expect(failure.message).toContain("D1 timed out");
    })
  );
});
