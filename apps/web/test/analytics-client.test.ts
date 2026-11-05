// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off -- The stubbed fetch is Promise-based, and its background request settles on a real timer.
import { setTimeout } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { AccountId } from "@rat-stack/core/contracts";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { AuthClient } from "../src/client/account/auth-client.js";
import { Analytics } from "../src/client/analytics/client.js";
import {
  AnalyticsCall,
  AnalyticsEvent,
} from "../src/client/analytics/events.js";
import { JobQueries } from "../src/client/board/queries.js";

const KEY = "phc_testProjectKey123";

const ada = Schema.decodeSync(AccountId)("user_ada");

const pageView = AnalyticsCall.Track({
  event: AnalyticsEvent.PageViewed({ route: "Board" }),
});

const SentEvent = Schema.Struct({
  distinct_id: Schema.String,
  event: Schema.String,
  properties: Schema.Record(
    Schema.String,
    Schema.Union([Schema.Boolean, Schema.Finite, Schema.String])
  ),
});

const decodeBatch = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ batch: Schema.Array(SentEvent) }))
);

const stubBrowser = () => {
  const idle: (() => void)[] = [];
  const pageListeners = new Map<string, () => void>();

  const page = {
    addEventListener: (name: string, listener: () => void) => {
      pageListeners.set(name, listener);
    },
    querySelector: (selector: string) =>
      selector.startsWith("meta") ? { getAttribute: () => KEY } : null,
    referrer: "",
    visibilityState: "visible",
  };

  vi.stubGlobal("document", page);
  vi.stubGlobal("navigator", { doNotTrack: null });
  vi.stubGlobal("location", {
    host: "jobs.example",
    origin: "https://jobs.example",
    pathname: "/",
  });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      readonly observe = vi.fn();
    }
  );
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    requestIdleCallback: (task: () => void) => {
      idle.push(task);
    },
  });

  return {
    becomeIdle: () => {
      for (const task of idle.splice(0)) {
        task();
      }
    },
    hide: () => {
      page.visibilityState = "hidden";
      pageListeners.get("visibilitychange")?.();
    },
  };
};

const pathOf = (url: URL | RequestInfo) =>
  url instanceof URL ? url.pathname : "";

const postings = () => {
  const bodies: string[] = [];

  return {
    bodies,
    events: () => bodies.flatMap((body) => decodeBatch(body).batch),
    fetch: async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(await new Response(init?.body).text());

      return new Response("{}");
    },
  };
};

const settled = Effect.promise(async () => {
  await setTimeout(5);
});

const withAnalytics = <A, E>(
  fetch: ReturnType<typeof postings>["fetch"],
  body: (send: Analytics["Service"]["send"]) => Effect.Effect<A, E>
) =>
  Analytics.use(({ send }) => body(send)).pipe(
    Effect.provide(Analytics.layer({})),
    Effect.provideService(FetchHttpClient.Fetch, fetch)
  );

describe("analytics transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("omits credentials for ingest and keeps them for the board", () =>
    Effect.gen(function* transports() {
      const browser = stubBrowser();
      const seen = new Map<string, RequestInit | undefined>();

      const fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
        seen.set(pathOf(url), init);

        return await Promise.resolve(new Response("{}", { status: 503 }));
      };

      yield* Effect.gen(function* visit() {
        const { send } = yield* Analytics;
        const queries = yield* JobQueries;
        const auth = yield* AuthClient;

        yield* send([AnalyticsCall.Anonymous(), pageView]);
        browser.becomeIdle();
        yield* Effect.ignore(queries.stats);
        yield* Effect.ignore(auth.currentAccount);
        yield* settled;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            JobQueries.layer.pipe(Layer.provideMerge(Analytics.layer({}))),
            AuthClient.layer
          )
        ),
        Effect.scoped,
        Effect.provideService(FetchHttpClient.Fetch, fetch)
      );

      expect(seen.get("/ingest/batch/")).toMatchObject({
        credentials: "omit",
        keepalive: true,
      });
      expect(seen.has("/rpc/")).toBe(true);
      expect(seen.get("/rpc/")?.credentials).not.toBe("omit");
      expect(seen.has("/api/auth/get-session")).toBe(true);
      expect(seen.get("/api/auth/get-session")?.credentials).not.toBe("omit");
    })
  );
});

describe("analytics identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect(
    "sends a signed-in visitor's first page view as their account",
    () =>
      Effect.gen(function* signedIn() {
        const browser = stubBrowser();
        const wire = postings();

        yield* withAnalytics(wire.fetch, (send) =>
          Effect.gen(function* visit() {
            yield* send([pageView]);
            browser.becomeIdle();
            yield* settled;

            expect(wire.bodies).toStrictEqual([]);

            yield* send([AnalyticsCall.Identify({ userId: ada })]);
            yield* settled;
          })
        );

        expect(
          wire.events().map(({ distinct_id, event, properties }) => ({
            distinct_id,
            event,
            person: properties.$process_person_profile,
          }))
        ).toStrictEqual([
          { distinct_id: ada, event: "$pageview", person: true },
        ]);
      })
  );

  it.effect(
    "sends an anonymous visitor's page view once the session is out",
    () =>
      Effect.gen(function* anonymous() {
        const browser = stubBrowser();
        const wire = postings();

        yield* withAnalytics(wire.fetch, (send) =>
          Effect.gen(function* visit() {
            yield* send([AnalyticsCall.Anonymous()]);
            yield* send([pageView]);
            browser.becomeIdle();
            yield* settled;
          })
        );

        const [view, ...rest] = wire.events();

        expect(rest).toStrictEqual([]);
        expect(view?.event).toBe("$pageview");
        expect(view?.distinct_id).not.toBe(ada);
        expect(view?.properties.$process_person_profile).toBe(false);
      })
  );

  it.effect("does not wait for the idle callback any longer than before", () =>
    Effect.gen(function* idleFirst() {
      const browser = stubBrowser();
      const wire = postings();

      yield* withAnalytics(wire.fetch, (send) =>
        Effect.gen(function* visit() {
          yield* send([pageView]);
          browser.becomeIdle();
          yield* send([AnalyticsCall.Anonymous()]);
          yield* settled;
        })
      );

      expect(wire.events().map(({ event }) => event)).toStrictEqual([
        "$pageview",
      ]);
    })
  );

  it.effect("releases held events when the tab hides, then merges them", () =>
    Effect.gen(function* hidden() {
      const browser = stubBrowser();
      const wire = postings();

      yield* withAnalytics(wire.fetch, (send) =>
        Effect.gen(function* visit() {
          yield* send([pageView]);
          browser.hide();
          yield* settled;

          expect(wire.events().map(({ event }) => event)).toStrictEqual([
            "$pageview",
          ]);

          yield* send([AnalyticsCall.Identify({ userId: ada })]);
          yield* settled;
        })
      );

      const [view, identify] = wire.events();

      expect(identify?.event).toBe("$identify");
      expect(identify?.distinct_id).toBe(ada);
      expect(identify?.properties.$anon_distinct_id).toBe(view?.distinct_id);
    })
  );

  it.effect("merges a visit that signs in after the session was out", () =>
    Effect.gen(function* midVisit() {
      const browser = stubBrowser();
      const wire = postings();

      yield* withAnalytics(wire.fetch, (send) =>
        Effect.gen(function* visit() {
          yield* send([AnalyticsCall.Anonymous(), pageView]);
          browser.becomeIdle();
          yield* settled;
          yield* send([AnalyticsCall.Identify({ userId: ada })]);
          yield* settled;
        })
      );

      const [view, identify] = wire.events();

      expect(view?.properties.$process_person_profile).toBe(false);
      expect(identify?.event).toBe("$identify");
      expect(identify?.properties.$anon_distinct_id).toBe(view?.distinct_id);
    })
  );
});
