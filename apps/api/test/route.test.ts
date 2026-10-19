import { describe, expect, it } from "@effect/vitest";
import { SESSION_COOKIE } from "@rat-stack/accounts";
import { Viewer } from "@rat-stack/core";
import type { AccountStore } from "@rat-stack/core";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import { handleRoutes } from "../src/route.js";

const ORIGIN = "https://jobs.rowlandekemezie.com";

const accountStore: AccountStore["Service"] = {
  signInOptions: { socialProviders: [] },
  viewerOf: () => Effect.succeed(Viewer.Anonymous()),
};

const handle = handleRoutes({
  accountStore,
  auth: Effect.succeed(HttpServerResponse.text("auth")),
  mcp: (request) =>
    Effect.succeed(HttpServerResponse.text(`mcp:${request.method}`)),
  rpc: (viewer) =>
    Effect.succeed(HttpServerResponse.text(`rpc:${viewer._tag}`)),
  stripeWebhook: (request) =>
    Effect.succeed(HttpServerResponse.text(`stripe:${request.method}`)),
  unsubscribe: (request) =>
    Effect.succeed(HttpServerResponse.text(`unsubscribe:${request.method}`)),
});

const send = (
  path: string,
  init: RequestInit = {}
): Effect.Effect<{ body: string; status: number }> =>
  Effect.gen(function* sent() {
    const response = yield* handle.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`${ORIGIN}${path}`, init))
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
          yield* send("/webhooks/stripe/extra", { method: "POST" })
        ).toEqual({ body: "rpc:Anonymous", status: 200 });
      })
  );

  it.effect(
    "keeps look-alike paths off the unsubscribe and auth handlers",
    () =>
      Effect.gen(function* lookalikes() {
        expect(yield* send("/unsubscribed", { method: "POST" })).toEqual({
          body: "rpc:Anonymous",
          status: 200,
        });
        expect(
          yield* send("/rpc?next=/unsubscribe", { method: "POST" })
        ).toEqual({ body: "rpc:Anonymous", status: 200 });
        expect(yield* send("/api/authority", { method: "POST" })).toEqual({
          body: "rpc:Anonymous",
          status: 200,
        });
      })
  );

  it.effect(
    "sends MCP to the agent handler without the session check, even cross-site with a cookie",
    () =>
      Effect.gen(function* mcp() {
        expect(
          yield* send("/mcp", { method: "POST", ...crossSiteWithSession })
        ).toEqual({ body: "mcp:POST", status: 200 });
        expect(yield* send("/mcpx", { method: "POST" })).toEqual({
          body: "rpc:Anonymous",
          status: 200,
        });
      })
  );
});
