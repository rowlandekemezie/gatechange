import { postHogConfigOf, postHogHostOf } from "@rat-stack/core";
import type { PostHogConfigValue } from "@rat-stack/core";
import { Effect, Option } from "effect";

import { ANALYTICS_KEY_META, INGEST_PREFIX } from "../edge-routes.js";

export interface AnalyticsBindings {
  readonly POSTHOG_PROJECT_KEY?: string;
  readonly POSTHOG_REGION?: string;
}

export const analyticsOf = (bindings: AnalyticsBindings) =>
  postHogConfigOf(bindings.POSTHOG_PROJECT_KEY, bindings.POSTHOG_REGION);

export const INGEST_PATHS: ReadonlySet<string> = new Set([
  "/batch/",
  "/decide/",
  "/e/",
  "/flags/",
  "/i/v0/e/",
]);

const FORWARDED_HEADERS = ["content-encoding", "content-type"];

const MAX_BODY_BYTES = 512 * 1024;

const NO_STORE = "no-store";

const refuse = (status: number) =>
  new Response(null, { headers: { "cache-control": NO_STORE }, status });

export const proxyIngest = (
  request: Request,
  config: Option.Option<PostHogConfigValue>,
  fetchUpstream: (request: Request) => Promise<Response>
) =>
  Effect.gen(function* proxyToPostHog() {
    const url = new URL(request.url);
    const path = url.pathname.slice(INGEST_PREFIX.length);

    if (Option.isNone(config) || !INGEST_PATHS.has(path)) {
      return refuse(404);
    }

    if (request.method !== "POST") {
      return refuse(405);
    }

    const body = yield* Effect.promise(
      // @effect-diagnostics-next-line asyncFunction:off -- The Fetch API body reader is Promise-based.
      async () => await request.arrayBuffer()
    );

    if (body.byteLength > MAX_BODY_BYTES) {
      return refuse(413);
    }

    const headers = new Headers();

    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);

      if (value !== null) {
        headers.set(name, value);
      }
    }

    const upstream = yield* Effect.promise(
      // @effect-diagnostics-next-line asyncFunction:off -- The Workers fetch API is Promise-based.
      async () =>
        await fetchUpstream(
          new Request(`${postHogHostOf(config.value)}${path}${url.search}`, {
            body,
            headers,
            method: "POST",
          })
        )
    );

    const response = new Response(upstream.body, upstream);

    response.headers.delete("set-cookie");
    response.headers.set("cache-control", NO_STORE);

    return response;
  }).pipe(Effect.catchDefect(() => Effect.succeed(refuse(502))));

export const withAnalyticsKey = (
  response: Response,
  config: Option.Option<PostHogConfigValue>
) =>
  Option.isNone(config) ||
  response.body === null ||
  !(response.headers.get("content-type") ?? "").startsWith("text/html")
    ? Effect.succeed(response)
    : Effect.promise(
        // @effect-diagnostics-next-line asyncFunction:off -- The Fetch API body reader is Promise-based.
        async () => await response.text()
      ).pipe(
        Effect.map((html) => {
          const tagged = new Response(
            html.replace(
              "</head>",
              `<meta name="${ANALYTICS_KEY_META}" content="${config.value.key}"></head>`
            ),
            response
          );

          tagged.headers.delete("content-length");

          return tagged;
        })
      );
