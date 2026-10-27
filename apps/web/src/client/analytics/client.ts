import { PostHogKey } from "@rat-stack/core/contracts";
import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Random,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { ANALYTICS_KEY_META, INGEST_PREFIX } from "../../edge-routes.js";
import {
  AnalyticsCall,
  AnalyticsEvent,
  eventNames,
  propertiesOf,
} from "./events.js";
import type { AnalyticsCallValue, Properties } from "./events.js";

export const INGEST_BATCH_PATH = `${INGEST_PREFIX}/batch/`;

const CAMPAIGN_PARAMS = [
  "ref",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
];

export const campaignOf = (search: string): Properties => {
  const params = new URLSearchParams(search);

  return Object.fromEntries(
    CAMPAIGN_PARAMS.flatMap((name) => {
      const value = params.get(name)?.trim().slice(0, 100) ?? "";

      return value === "" ? [] : [[name, value]];
    })
  );
};

const VERSION_7 = 0x70;

const RFC_VARIANT = 0x80;

export const uuidV7Of = (now: number, random: readonly number[]) => {
  const bytes = Array.from({ length: 16 }, (_, index) => {
    const byte = random[index] ?? 0;

    if (index < 6) {
      return Math.floor(now / 2 ** (8 * (5 - index))) % 256;
    }

    if (index === 6) {
      return VERSION_7 + (byte % 16);
    }

    return index === 8 ? RFC_VARIANT + (byte % 64) : byte;
  });

  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
};

const uuidV7 = Effect.zipWith(
  Clock.currentTimeMillis,
  Effect.forEach(Array.from({ length: 16 }), () =>
    Random.nextIntBetween(0, 255)
  ),
  uuidV7Of
);

export const analyticsKeyOf = (
  content: string | null | undefined,
  signals: { readonly doNotTrack: string | null; readonly gpc: boolean }
) =>
  signals.doNotTrack === "1" || signals.gpc
    ? Option.none()
    : Schema.decodeUnknownOption(PostHogKey)(content);

const referrerOf = (referrer: string): Properties => {
  const parsed = URL.parse(referrer);

  return parsed === null
    ? { $referrer: "$direct", $referring_domain: "$direct" }
    : { $referrer: parsed.origin, $referring_domain: parsed.host };
};

const APPLY_LINKS = [
  ["a.apply", "job_page"],
  ["a.job-source", "board_row"],
] as const;

export const applySourceOf = (target: Element) =>
  APPLY_LINKS.find(([selector]) => target.closest(selector) !== null)?.[1];

interface QueuedEvent {
  readonly distinct_id: string;
  readonly event: string;
  readonly properties: Properties;
  readonly timestamp: string;
  readonly uuid: string;
}

interface PrivacySignals {
  readonly globalPrivacyControl?: boolean;
}

const isPageView = (call: AnalyticsCallValue) =>
  AnalyticsCall.match(call, {
    Identify: () => false,
    Reset: () => false,
    Track: ({ event }) => Schema.is(AnalyticsEvent.PageViewed)(event),
  });

const disabled = {
  send: (_calls: readonly AnalyticsCallValue[]) => Effect.void,
};

const browserAnalytics = (campaign: Properties) =>
  Effect.gen(function* makeAnalytics() {
    // SAFETY: Global Privacy Control is a Navigator field TypeScript's DOM types do not declare yet.
    const signals = navigator as Navigator & PrivacySignals;

    const key = analyticsKeyOf(
      document
        .querySelector(`meta[name="${ANALYTICS_KEY_META}"]`)
        ?.getAttribute("content"),
      {
        doNotTrack: signals.doNotTrack,
        gpc: signals.globalPrivacyControl === true,
      }
    );

    if (Option.isNone(key)) {
      return disabled;
    }

    const client = yield* HttpClient.HttpClient;
    const run = Effect.runForkWith(yield* Effect.context());
    const sessionId = yield* uuidV7;
    const referrer = referrerOf(document.referrer);

    const state = {
      anonymousId: yield* uuidV7,
      ready: false,
      userId: Option.none<string>(),
    };

    const queue: QueuedEvent[] = [];

    const flush = Effect.suspend(() =>
      state.ready && queue.length > 0
        ? client
            .execute(
              HttpClientRequest.post(INGEST_BATCH_PATH).pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  api_key: key.value,
                  batch: queue.splice(0),
                })
              )
            )
            .pipe(Effect.ignore, Effect.forkDetach, Effect.asVoid)
        : Effect.void
    );

    const record = (event: string, properties: Properties) =>
      Effect.gen(function* recordEvent() {
        const now = yield* Clock.currentTimeMillis;

        queue.push({
          distinct_id: Option.getOrElse(state.userId, () => state.anonymousId),
          event,
          properties: {
            ...campaign,
            ...referrer,
            $current_url: `${location.origin}${location.pathname}`,
            $geoip_disable: true,
            $host: location.host,
            $lib: "jobs-web",
            $pathname: location.pathname,
            $process_person_profile: Option.isSome(state.userId),
            $session_id: sessionId,
            ...properties,
          },
          timestamp: DateTime.formatIso(DateTime.makeUnsafe(now)),
          uuid: yield* uuidV7,
        });
      });

    const handle = (call: AnalyticsCallValue) =>
      AnalyticsCall.match(call, {
        Identify: ({ userId }) =>
          Option.contains(state.userId, userId)
            ? Effect.void
            : Effect.sync(() => {
                state.userId = Option.some(userId);
              }).pipe(
                Effect.andThen(
                  record("$identify", { $anon_distinct_id: state.anonymousId })
                )
              ),
        Reset: () =>
          uuidV7.pipe(
            Effect.flatMap((anonymousId) =>
              Effect.sync(() => {
                state.userId = Option.none();
                state.anonymousId = anonymousId;
              })
            )
          ),
        Track: ({ event }) =>
          record(eventNames[event._tag], propertiesOf(event)),
      });

    const track = (calls: readonly AnalyticsCallValue[]) =>
      Effect.forEach(calls, handle, { discard: true }).pipe(
        Effect.andThen(flush)
      );

    const start = () => {
      state.ready = true;
      run(flush);
    };

    const agents = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        agents.disconnect();
        run(
          track([
            AnalyticsCall.Track({
              event: AnalyticsEvent.AgentsSectionViewed(),
            }),
          ])
        );
      }
    });

    const watchAgents = Effect.sync(() =>
      requestAnimationFrame(() => {
        const section = document.querySelector("#agents");

        if (section !== null) {
          agents.observe(section);
        }
      })
    );

    if (Reflect.has(window, "requestIdleCallback")) {
      window.requestIdleCallback(start, { timeout: 4000 });
    } else {
      window.setTimeout(start, 2000);
    }

    window.addEventListener("pointerdown", start, {
      once: true,
      passive: true,
    });
    window.addEventListener("keydown", start, { once: true, passive: true });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        start();
      }
    });

    document.addEventListener(
      "click",
      (event) => {
        const source =
          event.target instanceof Element
            ? applySourceOf(event.target)
            : undefined;

        if (source !== undefined) {
          run(
            track([
              AnalyticsCall.Track({
                event: AnalyticsEvent.ApplyClicked({ source }),
              }),
            ])
          );
        }
      },
      { capture: true }
    );

    return {
      send: (calls: readonly AnalyticsCallValue[]) =>
        calls.some(isPageView)
          ? Effect.andThen(track(calls), watchAgents)
          : track(calls),
    };
  });

export class Analytics extends Context.Service<Analytics, typeof disabled>()(
  "@rat-stack/web/Analytics"
) {
  static readonly layer = (campaign: Properties) =>
    Layer.effect(this, browserAnalytics(campaign)).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(
        Layer.succeed(FetchHttpClient.RequestInit, {
          credentials: "omit",
          keepalive: true,
        })
      )
    );
}
