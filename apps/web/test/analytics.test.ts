// @effect-diagnostics asyncFunction:off -- The module Worker fetch handler and its bindings are Promise-based.
import { describe, expect, it } from "@effect/vitest";
import { Account } from "@rat-stack/core/contracts";
import { Effect, Option, Schema } from "effect";
import { fromString } from "foldkit/url";
import { afterEach, vi } from "vitest";

import { Message as AccountMessage } from "../src/client/account/message.js";
import {
  analyticsKeyOf,
  campaignOf,
  uuidV7Of,
} from "../src/client/analytics/client.js";
import {
  AnalyticsCall,
  AnalyticsEvent,
  callsOf,
  eventNames,
  landingCallsOf,
  propertiesOf,
} from "../src/client/analytics/events.js";
import { application } from "../src/client/application.js";
import { Message } from "../src/client/board/message.js";
import { Preload } from "../src/client/board/model.js";
import type { ModelValue } from "../src/client/board/model.js";
import { jobRouter } from "../src/client/route.js";
import {
  analyticsOf,
  proxyIngest,
  withAnalyticsKey,
} from "../src/server/analytics.js";
import worker from "../src/worker.js";

const ORIGIN = "https://jobs.example";

const KEY = "phc_testProjectKey123";

const configured = analyticsOf({
  POSTHOG_PROJECT_KEY: KEY,
  POSTHOG_REGION: "eu",
});

const ada = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

const modelAt = (path: string): ModelValue =>
  application.init(
    { origin: ORIGIN, preload: Preload.Nothing() },
    Option.getOrThrow(fromString(`${ORIGIN}${path}`))
  ).model;

const step = (model: ModelValue, message: typeof Message.Type) => {
  const after = application.update(model, message).model;

  return { after, calls: callsOf(message, model, after) };
};

const tracked = (calls: readonly (typeof AnalyticsCall.Type)[]) =>
  calls.flatMap((call) =>
    Schema.is(AnalyticsCall.Track)(call) ? [call.event] : []
  );

describe("analytics events", () => {
  it("names every event on the wire in snake case", () => {
    expect(Object.values(eventNames)).toContain("search_submitted");
    expect(
      propertiesOf(AnalyticsEvent.SearchSubmitted({ queryLength: 4 }))
    ).toStrictEqual({ query_length: 4 });
  });

  it("counts a submitted search by length and never sends its text", () => {
    const typed = step(
      modelAt("/"),
      Message.UpdatedDraftSearch({ value: " staff platform " })
    ).after;

    const { calls } = step(typed, Message.SubmittedSearch());

    expect(tracked(calls)).toContainEqual(
      AnalyticsEvent.SearchSubmitted({ queryLength: 14 })
    );
    expect(JSON.stringify(calls)).not.toContain("platform");
  });

  it("reports which filter changed without a page view for the same board", () => {
    const { calls } = step(
      modelAt("/"),
      Message.ChangedSort({ sort: "Newest" })
    );

    expect(tracked(calls)).toStrictEqual([
      AnalyticsEvent.FilterChanged({ filter: "sort" }),
    ]);
  });

  it("views a page on landing and marks pricing and job pages", () => {
    expect(tracked(landingCallsOf(modelAt("/pricing")))).toStrictEqual([
      AnalyticsEvent.PageViewed({ route: "Pricing" }),
      AnalyticsEvent.PricingViewed(),
    ]);
    expect(
      tracked(landingCallsOf(modelAt(jobRouter({ id: "greenhouse:acme/1" }))))
    ).toContainEqual(AnalyticsEvent.JobOpened());
  });

  it("identifies a signed-in member by account id, never email, and resets on sign-out", () => {
    const signedOut = step(
      modelAt("/"),
      Message.GotAccountMessage({
        message: AccountMessage.CompletedFetchSession({
          account: Option.none(),
        }),
      })
    ).after;

    const signIn = step(
      signedOut,
      Message.GotAccountMessage({
        message: AccountMessage.CompletedFetchSession({
          account: Option.some(ada),
        }),
      })
    );

    expect(signIn.calls).toStrictEqual([
      AnalyticsCall.Identify({ userId: ada.id }),
      AnalyticsCall.Track({ event: AnalyticsEvent.SigninCompleted() }),
    ]);
    expect(JSON.stringify(signIn.calls)).not.toContain(ada.email);

    const signOut = step(
      signIn.after,
      Message.GotAccountMessage({ message: AccountMessage.CompletedSignOut() })
    );

    expect(signOut.calls).toContainEqual(AnalyticsCall.Reset());
  });

  it("keeps only campaign parameters from the landing URL", () => {
    expect(
      campaignOf("?ref=producthunt&utm_source=ph&q=director&utm_medium=")
    ).toStrictEqual({ ref: "producthunt", utm_source: "ph" });
  });

  it("builds version 7 identifiers that sort by time", () => {
    const id = uuidV7Of(
      1_760_000_000_000,
      Array.from({ length: 16 }, () => 255)
    );

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(uuidV7Of(1, []) < uuidV7Of(2, [])).toBe(true);
  });

  it("stays off without a key or when the browser asks not to be tracked", () => {
    const signals = { doNotTrack: null, gpc: false };

    expect(analyticsKeyOf(null, signals)).toStrictEqual(Option.none());
    expect(analyticsKeyOf("not-a-key", signals)).toStrictEqual(Option.none());
    expect(analyticsKeyOf(KEY, { ...signals, gpc: true })).toStrictEqual(
      Option.none()
    );
    expect(analyticsKeyOf(KEY, { ...signals, doNotTrack: "1" })).toStrictEqual(
      Option.none()
    );
    expect(analyticsKeyOf(KEY, signals)).toStrictEqual(Option.some(KEY));
  });
});

const page = () =>
  new Response("<html><head></head><body></body></html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const upstreamSpy = () =>
  vi.fn(async (_request: Request) => {
    await Promise.resolve();

    return new Response('{"status":1}', {
      headers: {
        "cache-control": "public, max-age=3600",
        "set-cookie": "ph=1",
      },
      status: 200,
    });
  });

const ingest = (path: string, init: RequestInit = {}) =>
  new Request(`${ORIGIN}/ingest${path}`, {
    body: init.method === "GET" ? null : '{"batch":[]}',
    headers: {
      authorization: "Bearer member-token",
      "content-type": "application/json",
      cookie: "better-auth.session_token=secret",
    },
    method: "POST",
    ...init,
  });

describe("ingest proxy", () => {
  it.effect(
    "forwards allowlisted paths to the region host without credentials or caching",
    () =>
      Effect.gen(function* proxyForwards() {
        const upstream = upstreamSpy();

        const response = yield* proxyIngest(
          ingest("/batch/?compression=none"),
          configured,
          upstream
        );

        const sent = upstream.mock.calls[0]?.[0];

        expect(sent?.url).toBe(
          "https://eu.i.posthog.com/batch/?compression=none"
        );
        expect(sent?.headers.has("cookie")).toBe(false);
        expect(sent?.headers.has("authorization")).toBe(false);
        expect(sent?.headers.get("content-type")).toBe("application/json");
        expect(response.status).toBe(200);
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(response.headers.get("cache-control")).toBe("no-store");
      })
  );

  it.effect("refuses paths outside the allowlist and non-POST methods", () =>
    Effect.gen(function* proxyRefuses() {
      const upstream = upstreamSpy();

      const decoy = yield* proxyIngest(
        ingest("/api/projects/"),
        configured,
        upstream
      );

      const read = yield* proxyIngest(
        ingest("/flags/", { method: "GET" }),
        configured,
        upstream
      );

      expect(decoy.status).toBe(404);
      expect(read.status).toBe(405);
      expect(upstream).not.toHaveBeenCalled();
    })
  );

  it.effect("is a no-op without PostHog config", () =>
    Effect.gen(function* proxyOff() {
      const upstream = upstreamSpy();

      const response = yield* proxyIngest(
        ingest("/batch/"),
        analyticsOf({}),
        upstream
      );

      expect(response.status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    })
  );

  it.effect("puts the project key in HTML only when configured", () =>
    Effect.gen(function* injectKey() {
      const off = yield* withAnalyticsKey(page(), analyticsOf({}));
      const on = yield* withAnalyticsKey(page(), configured);

      const json = yield* withAnalyticsKey(
        Response.json({ ok: true }),
        configured
      );

      expect(yield* Effect.promise(async () => await off.text())).not.toContain(
        "posthog-key"
      );
      expect(yield* Effect.promise(async () => await on.text())).toContain(
        `<meta name="posthog-key" content="${KEY}"></head>`
      );
      expect(yield* Effect.promise(async () => await json.text())).toBe(
        '{"ok":true}'
      );
    })
  );
});

describe("worker ingest route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const bindings = {
    ASSETS: { fetch: async () => await Promise.resolve(new Response("x")) },
    BACKEND: { fetch: async () => await Promise.resolve(new Response("x")) },
    MCP_ANONYMOUS_LIMIT: {
      limit: async () => await Promise.resolve({ success: true }),
    },
    MCP_TOKEN_LIMIT: {
      limit: async () => await Promise.resolve({ success: true }),
    },
  };

  const lifetime = {
    waitUntil: () => {
      expect.fail("the ingest route schedules no background work");
    },
  };

  it("never reaches the backend, and proxies only when configured", async () => {
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const off = await worker.fetch(ingest("/e/"), bindings, lifetime);

    expect(off.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();

    const on = await worker.fetch(
      ingest("/e/"),
      { ...bindings, POSTHOG_PROJECT_KEY: KEY, POSTHOG_REGION: "us" },
      lifetime
    );

    expect(on.status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBeInstanceOf(Request);
    expect(new Request(upstream.mock.calls[0]?.[0] ?? "").url).toBe(
      "https://us.i.posthog.com/e/"
    );
  });
});
