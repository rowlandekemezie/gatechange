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

const UNLIMITED = {
  anonymous: Number.POSITIVE_INFINITY,
  token: Number.POSITIVE_INFINITY,
};

const edge = (
  backendHeaders: Record<string, string> = {},
  allowed: { readonly anonymous: number; readonly token: number } = UNLIMITED
) => {
  const seen: { binding: BindingName; path: string }[] = [];
  const limited: { key: string; limiter: "anonymous" | "token" }[] = [];

  const limiter = (name: "anonymous" | "token") => ({
    // @effect-diagnostics-next-line asyncFunction:off -- Fakes the Promise-returning Rate Limiting binding.
    limit: async ({ key }: { readonly key: string }) => {
      limited.push({ key, limiter: name });

      return await Promise.resolve({
        success:
          limited.filter((call) => call.limiter === name && call.key === key)
            .length <= allowed[name],
      });
    },
  });

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
    MCP_ANONYMOUS_LIMIT: limiter("anonymous"),
    MCP_TOKEN_LIMIT: limiter("token"),
    SITE_INDEXING: "index",
  };

  const lifetime = {
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
  };

  const get = (path: string, headers: HeadersInit = {}, method = "GET") =>
    Effect.promise(
      // @effect-diagnostics-next-line asyncFunction:off -- The edge Worker's fetch is Promise-based.
      async () =>
        await worker.fetch(
          new Request(`https://jobs.example${path}`, { headers, method }),
          bindings,
          lifetime
        )
    );

  return { get, limited, seen };
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

  it.effect.each(["/rpc", "/api/auth/get-session"])(
    "keeps %s private even when the backend sets no cookie",
    (path) =>
      Effect.gen(function* backendWithoutCookie() {
        const { get } = edge({ "cache-control": PUBLIC_CACHE_CONTROL });
        const response = yield* get(path);

        expect(response.headers.get("cache-control")).toBe(
          PRIVATE_CACHE_CONTROL
        );
      })
  );

  it.effect.each(["/account", "/account/confirm?token=abc"])(
    "sends no referrer from %s",
    (path) =>
      Effect.gen(function* noReferrer() {
        const { get } = edge();
        const response = yield* get(path);

        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      })
  );

  it.effect("leaves referrers alone on public pages", () =>
    Effect.gen(function* publicReferrer() {
      const { get } = edge();
      const response = yield* get("/accounting-jobs");

      expect(response.headers.get("referrer-policy")).toBeNull();
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

  it("runs the Worker first for the MCP endpoint and its discovery document", () => {
    expect(workerFirstPaths).toStrictEqual(
      expect.arrayContaining(["/mcp", "/.well-known/mcp.json"])
    );
  });

  it.effect("forwards MCP calls to the backend and keeps them private", () =>
    Effect.gen(function* mcpForwarded() {
      const { get, limited, seen } = edge({
        "cache-control": PUBLIC_CACHE_CONTROL,
      });

      const response = yield* get(
        "/mcp",
        { "cf-connecting-ip": "203.0.113.7" },
        "POST"
      );

      expect(yield* bodyOf(response)).toBe("BACKEND");
      expect(seen).toStrictEqual([{ binding: "BACKEND", path: "/mcp" }]);
      expect(limited).toStrictEqual([
        { key: "jobs.example|203.0.113.7", limiter: "anonymous" },
      ]);
      expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    })
  );

  it.effect(
    "refuses anonymous MCP calls past the per-address limit with retry guidance",
    () =>
      Effect.gen(function* anonymousLimit() {
        const { get, seen } = edge({}, { anonymous: 2, token: 2 });
        const caller = { "cf-connecting-ip": "203.0.113.7" };

        yield* get("/mcp", caller, "POST");
        yield* get("/mcp", caller, "POST");

        const refused = yield* get("/mcp", caller, "POST");

        const other = yield* get(
          "/mcp",
          { "cf-connecting-ip": "198.51.100.9" },
          "POST"
        );

        expect(refused.status).toBe(429);
        expect(refused.headers.get("retry-after")).toBe("60");
        expect(yield* bodyOf(refused)).toContain("Retry in 60 seconds");
        expect(other.status).toBe(200);
        expect(seen).toHaveLength(3);
      })
  );

  it.effect("counts token-bearing MCP calls on their own limiter", () =>
    Effect.gen(function* tokenLimit() {
      const { get, limited } = edge({}, { anonymous: 0, token: 1 });

      const response = yield* get(
        "/mcp",
        {
          authorization: "Bearer jobs_pat_x",
          "cf-connecting-ip": "203.0.113.7",
        },
        "POST"
      );

      expect(response.status).toBe(200);
      expect(limited.map(({ limiter }) => limiter)).toStrictEqual(["token"]);
    })
  );

  it.effect(
    "serves the MCP discovery document without counting it against the limit",
    () =>
      Effect.gen(function* discovery() {
        const { get, limited, seen } = edge({}, { anonymous: 0, token: 0 });

        expect(yield* bodyOf(yield* get("/.well-known/mcp.json"))).toBe(
          "BACKEND"
        );
        expect(seen).toStrictEqual([
          { binding: "BACKEND", path: "/.well-known/mcp.json" },
        ]);
        expect(limited).toStrictEqual([]);
      })
  );
});
