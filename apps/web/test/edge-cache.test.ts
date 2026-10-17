// @effect-diagnostics asyncFunction:off -- The Workers Cache API stub is Promise-based.
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import { throughEdgeCache } from "../src/server/edge-cache.js";

const KEY = new Request("https://jobs.example/companies/acme");

const stored = new Map<string, Response>();

const lifetime = {
  waitUntil: (work: Promise<unknown>) => {
    void work;
  },
};

beforeEach(() => {
  vi.stubGlobal("caches", {
    open: async () =>
      await Promise.resolve({
        match: async (key: Request) =>
          await Promise.resolve(stored.get(key.url)),
        put: async (key: Request, response: Response) => {
          stored.set(key.url, response);
          await Promise.resolve();
        },
      }),
  });
});

afterEach(() => {
  stored.clear();
  vi.unstubAllGlobals();
});

describe("throughEdgeCache", () => {
  it.effect("never stores a response that sets a cookie", () =>
    Effect.gen(function* setCookieResponse() {
      const response = yield* throughEdgeCache(
        new Request(KEY.url),
        KEY,
        lifetime,
        Effect.succeed(
          new Response("page", { headers: { "set-cookie": "session=abc" } })
        )
      );

      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(stored.size).toBe(0);
    })
  );

  it.effect("stores an anonymous 200 response", () =>
    Effect.gen(function* anonymousResponse() {
      const response = yield* throughEdgeCache(
        new Request(KEY.url),
        KEY,
        lifetime,
        Effect.succeed(new Response("page"))
      );

      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=0, s-maxage=600"
      );
      expect(stored.size).toBe(1);
    })
  );
});
