import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import { PRIVATE_CACHE_CONTROL, workerFirstPaths } from "../src/edge-routes.js";
import worker from "../src/worker.js";

const PUBLIC_CACHE_CONTROL = "public, max-age=0, s-maxage=600";

type BindingName = "ASSETS" | "BACKEND";

const stored = new Map<string, Response>();

const pending: Promise<unknown>[] = [];

const pageCache = {
  // @effect-diagnostics-next-line asyncFunction:off -- Fakes the Promise-based Cache API.
  match: async (key: Request) => await Promise.resolve(stored.get(key.url)),
  // @effect-diagnostics-next-line asyncFunction:off -- Fakes the Promise-based Cache API.
  put: async (key: Request, response: Response) => {
    stored.set(key.url, await Promise.resolve(response));
  },
};

const edge = (backendHeaders: Record<string, string> = {}) => {
  const seen: { binding: BindingName; path: string }[] = [];

  const binding = (name: BindingName, headers: HeadersInit) => ({
    // @effect-diagnostics-next-line asyncFunction:off -- Fakes the Promise-returning service binding contract.
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);

      seen.push({ binding: name, path: new URL(request.url).pathname });

      return await Promise.resolve(new Response(name, { headers }));
    },
  });

  const bindings = {
    ASSETS: binding("ASSETS", { "cache-control": PUBLIC_CACHE_CONTROL }),
    BACKEND: binding("BACKEND", backendHeaders),
    SITE_INDEXING: "index",
  };

  const lifetime = {
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
  };

  const get = (path: string, headers: HeadersInit = {}) =>
    Effect.promise(
      // @effect-diagnostics-next-line asyncFunction:off -- The edge Worker's fetch is Promise-based.
      async () =>
        await worker.fetch(
          new Request(`https://jobs.example${path}`, { headers }),
          bindings,
          lifetime
        )
    );

  return { get, seen };
};

const bodyOf = (response: Response) =>
  Effect.promise(
    // @effect-diagnostics-next-line asyncFunction:off -- Response.text is Promise-based.
    async () => await response.text()
  );

beforeEach(() => {
  vi.stubGlobal("caches", {
    // @effect-diagnostics-next-line asyncFunction:off -- Fakes the Promise-based Cache API.
    open: async () => await Promise.resolve(pageCache),
  });
});

afterEach(() => {
  stored.clear();
  pending.length = 0;
  vi.unstubAllGlobals();
});

describe("edge routing", () => {
  it.effect.each([
    "/rpc",
    "/api/auth/sign-in/magic-link",
    "/api/auth/get-session",
  ])("sends %s to the backend and nothing else", (path) =>
    Effect.gen(function* backendRoute() {
      const { get, seen } = edge();

      expect(yield* bodyOf(yield* get(path))).toBe("BACKEND");
      expect(seen).toStrictEqual([{ binding: "BACKEND", path }]);
    })
  );

  it.effect.each(["/account", "/account/confirm?token=abc"])(
    "serves %s from the static shell and forbids shared caching",
    (path) =>
      Effect.gen(function* privateRoute() {
        const { get, seen } = edge();
        const response = yield* get(path);

        expect(yield* bodyOf(response)).toBe("ASSETS");
        expect(seen.map(({ binding }) => binding)).toStrictEqual(["ASSETS"]);
        expect(response.headers.get("cache-control")).toBe(
          PRIVATE_CACHE_CONTROL
        );
      })
  );

  it.effect(
    "forbids shared caching of any response that sets a session cookie",
    () =>
      Effect.gen(function* sessionCookie() {
        const { get } = edge({
          "cache-control": PUBLIC_CACHE_CONTROL,
          "set-cookie":
            "__Secure-better-auth.session_token=t; Secure; HttpOnly",
        });

        const response = yield* get("/api/auth/magic-link/verify");

        expect(response.headers.get("cache-control")).toBe(
          PRIVATE_CACHE_CONTROL
        );
        expect(response.headers.get("set-cookie")).toContain("session_token=t");
      })
  );

  it.effect.each(["/jobs/abc", "/accounting-jobs"])(
    "leaves the public path %s cacheable",
    (path) =>
      Effect.gen(function* publicRoute() {
        const { get } = edge();
        const response = yield* get(path);

        expect(response.headers.get("cache-control")).toBe(
          PUBLIC_CACHE_CONTROL
        );
      })
  );

  it("runs the Worker first for every backend and private path", () => {
    expect(workerFirstPaths).toStrictEqual(
      expect.arrayContaining([
        "/rpc/*",
        "/api/auth/*",
        "/account",
        "/account/*",
      ])
    );
  });
});
