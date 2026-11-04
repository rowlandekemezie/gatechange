import { describe, expect, it } from "@effect/vitest";
import { SESSION_COOKIE } from "@rat-stack/accounts";
import { Viewer } from "@rat-stack/core";
import type { AccountStore } from "@rat-stack/core";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import { handleRoutes } from "../src/route.js";

const ORIGIN = "https://jobs.rowlandekemezie.com";

const sessionLookups = { count: 0 };

const accountStore: AccountStore["Service"] = {
  signInOptions: { socialProviders: [] },
  viewerOf: () =>
    Effect.sync(() => {
      sessionLookups.count += 1;

      return Viewer.Anonymous();
    }),
};

const handle = handleRoutes({
  accountStore,
  auth: Effect.succeed(HttpServerResponse.text("auth")),
  mcp: (request) =>
    Effect.succeed(HttpServerResponse.text(`mcp:${request.method}`)),
  mcpDiscovery: () => HttpServerResponse.text("discovery"),
  rpc: (viewer) =>
    Effect.succeed(HttpServerResponse.text(`rpc:${viewer._tag}`)),
  stripeWebhook: (request) =>
    Effect.succeed(HttpServerResponse.text(`stripe:${request.method}`)),
  unsubscribe: (request) =>
    Effect.succeed(HttpServerResponse.text(`unsubscribe:${request.method}`)),
});

const deliver = (
  request: Request
): Effect.Effect<{ body: string; status: number }> =>
  Effect.gen(function* sent() {
    const response = yield* handle.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request)
      )
    );

    const web = HttpServerResponse.toWeb(response);

    return {
      body: yield* Effect.promise(
        // @effect-diagnostics-next-line asyncFunction:off -- The Web Response body is Promise-based.
        async () => await web.text()
      ),
      status: web.status,
    };
  });

const send = (path: string, init: RequestInit = {}) =>
  deliver(new Request(`${ORIGIN}${path}`, init));

const rpcPost = (body: string) =>
  send("/rpc/", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const crossSiteWithSession = {
  headers: {
    cookie: `${SESSION_COOKIE}=abc`,
    "sec-fetch-site": "cross-site",
  },
};

describe("backend routing", () => {
  it.effect(
    "sends auth paths to better-auth, even cross-site with a session",
    () =>
      Effect.gen(function* auth() {
        expect(yield* send("/api/auth/get-session")).toEqual({
          body: "auth",
          status: 200,
        });
        expect(
          yield* send("/api/auth/sign-out", {
            method: "POST",
            ...crossSiteWithSession,
          })
        ).toEqual({ body: "auth", status: 200 });
      })
  );

  it.effect("serves RPC to the viewer on a same-site request", () =>
    Effect.gen(function* rpc() {
      expect(yield* send("/rpc", { method: "POST" })).toEqual({
        body: "rpc:Anonymous",
        status: 200,
      });
      expect(
        yield* send("/rpc", {
          headers: {
            cookie: `${SESSION_COOKIE}=abc`,
            "sec-fetch-site": "same-origin",
          },
          method: "POST",
        })
      ).toEqual({ body: "rpc:Anonymous", status: 200 });
    })
  );

  it.effect(
    "refuses a cross-site RPC request that carries a session cookie",
    () =>
      Effect.gen(function* refused() {
        expect(
          yield* send("/rpc", { method: "POST", ...crossSiteWithSession })
        ).toEqual({ body: "Cross-site request refused.", status: 403 });
      })
  );

  it.effect(
    "lets a cross-site cookieless RPC request through as anonymous",
    () =>
      Effect.gen(function* anonymous() {
        expect(
          yield* send("/rpc", {
            headers: { "sec-fetch-site": "cross-site" },
            method: "POST",
          })
        ).toEqual({ body: "rpc:Anonymous", status: 200 });
      })
  );

  it.effect(
    "sends unsubscribe GETs and POSTs from an email to the handler, never a 403",
    () =>
      Effect.gen(function* unsubscribe() {
        expect(
          yield* send("/unsubscribe?token=t", {
            headers: {
              cookie: `${SESSION_COOKIE}=abc`,
              "sec-fetch-site": "cross-site",
            },
          })
        ).toEqual({ body: "unsubscribe:GET", status: 200 });
        expect(
          yield* send("/unsubscribe?token=t", {
            headers: { "sec-fetch-site": "cross-site" },
            method: "POST",
          })
        ).toEqual({ body: "unsubscribe:POST", status: 200 });
      })
  );

  it.effect(
    "sends Stripe deliveries to the webhook handler, never through the session check",
    () =>
      Effect.gen(function* stripe() {
        expect(
          yield* send("/webhooks/stripe", {
            headers: { "sec-fetch-site": "cross-site" },
            method: "POST",
          })
        ).toEqual({ body: "stripe:POST", status: 200 });
        expect(
          yield* send("/webhooks/stripe", {
            method: "POST",
            ...crossSiteWithSession,
          })
        ).toEqual({ body: "stripe:POST", status: 200 });
        expect(
          (yield* send("/webhooks/stripe/extra", { method: "POST" })).status
        ).toBe(404);
      })
  );

  it.effect(
    "keeps look-alike paths off the unsubscribe and auth handlers",
    () =>
      Effect.gen(function* lookalikes() {
        expect((yield* send("/unsubscribed", { method: "POST" })).status).toBe(
          404
        );
        expect(
          yield* send("/rpc?next=/unsubscribe", { method: "POST" })
        ).toEqual({ body: "rpc:Anonymous", status: 200 });
        expect((yield* send("/api/authority", { method: "POST" })).status).toBe(
          404
        );
      })
  );

  it.effect(
    "sends MCP to the agent handler without the session check, even cross-site with a cookie",
    () =>
      Effect.gen(function* mcp() {
        expect(
          yield* send("/mcp", { method: "POST", ...crossSiteWithSession })
        ).toEqual({ body: "mcp:POST", status: 200 });
        expect(yield* send("/.well-known/mcp.json")).toEqual({
          body: "discovery",
          status: 200,
        });
        expect((yield* send("/mcpx", { method: "POST" })).status).toBe(404);
      })
  );
});

const postOf = (path: string, body = '{"_tag":"Request"}') =>
  new Request(`${ORIGIN}${path}`, {
    body,
    headers: { cookie: `${SESSION_COOKIE}=abc` },
    method: "POST",
  });

describe("RPC lives only under /rpc", () => {
  it.effect.each(["/rpc", "/rpc/", "/rpc/anything"])(
    "serves %s as RPC, the control for the refusals below",
    (path) =>
      Effect.gen(function* served() {
        const request = postOf(path);
        const lookupsBefore = sessionLookups.count;

        expect(yield* deliver(request)).toEqual({
          body: "rpc:Anonymous",
          status: 200,
        });
        expect(request.bodyUsed).toBe(true);
        expect(sessionLookups.count).toBe(lookupsBefore + 1);
      })
  );

  it.effect.each([
    "/",
    "/rpcx",
    "/mcp/",
    "/mcp/extra",
    "/unsubscribe/",
    "/unsubscribe/extra",
    "/webhooks/stripe/",
    "/webhooks/stripe/extra",
    "/.well-known/mcp.json/",
    "/.well-known/mcp.json/extra",
  ])("answers 404 for %s before the body or the session is read", (path) =>
    Effect.gen(function* refused() {
      const request = postOf(path);
      const lookupsBefore = sessionLookups.count;

      const response = yield* deliver(request);

      expect(response.status).toBe(404);
      expect(response.body).not.toContain("rpc:");
      expect(request.bodyUsed).toBe(false);
      expect(sessionLookups.count).toBe(lookupsBefore);
    })
  );

  it.effect("answers 404, not the batch 400, for an array off /rpc", () =>
    Effect.gen(function* offPathBatch() {
      const response = yield* deliver(postOf("/unsubscribe/", "[]"));

      expect(response.status).toBe(404);
    })
  );
});

describe("one call per /rpc POST", () => {
  it.effect.each(["[]", '[{"_tag":"Request"}]', ' \n\t[{"_tag":"Request"}]'])(
    "refuses the batch %j before it reaches the RPC server",
    (body) =>
      Effect.gen(function* refusedBatch() {
        const response = yield* rpcPost(body);

        expect(response.status).toBe(400);
        expect(response.body).not.toContain("rpc:");
      })
  );

  it.effect("serves a single message and leaves its body readable", () =>
    Effect.gen(function* singleMessage() {
      const echo = handleRoutes({
        accountStore,
        auth: Effect.succeed(HttpServerResponse.text("auth")),
        mcp: () => Effect.succeed(HttpServerResponse.text("mcp")),
        mcpDiscovery: () => HttpServerResponse.text("discovery"),
        rpc: () =>
          HttpServerRequest.HttpServerRequest.pipe(
            Effect.flatMap((request) => request.text),
            Effect.orDie,
            Effect.map((text) => HttpServerResponse.text(text))
          ),
        stripeWebhook: () => Effect.succeed(HttpServerResponse.text("stripe")),
        unsubscribe: () => Effect.succeed(HttpServerResponse.text("unsub")),
      });

      const response = yield* echo.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`${ORIGIN}/rpc/`, {
              body: '{"_tag":"Request"}',
              method: "POST",
            })
          )
        )
      );

      expect(
        yield* Effect.promise(
          // @effect-diagnostics-next-line asyncFunction:off -- The Web Response body is Promise-based.
          async () => await HttpServerResponse.toWeb(response).text()
        )
      ).toBe('{"_tag":"Request"}');
    })
  );
});
