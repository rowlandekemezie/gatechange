import { postHogConfigOf, postHogHostOf } from "@rat-stack/core";
import type { PostHogConfigValue } from "@rat-stack/core";
import { Effect, Option, Schema } from "effect";

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

const MAX_BODY_BYTES = 512 * 1024;

const ProjectKeyed = Schema.fromJsonString(
  Schema.Struct({
    api_key: Schema.optional(Schema.String),
    token: Schema.optional(Schema.String),
  })
);

const keyOfBody = (body: string) =>
  Schema.decodeUnknownOption(ProjectKeyed)(body).pipe(
    Option.flatMap(({ api_key: apiKey, token }) =>
      Option.fromNullishOr(apiKey ?? token)
    )
  );

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

    const length = Number(request.headers.get("content-length") ?? Number.NaN);

    if (!Number.isFinite(length) || length > MAX_BODY_BYTES) {
      return refuse(413);
    }

    if (request.headers.has("content-encoding")) {
      return refuse(415);
    }

    const body = yield* Effect.promise(
      // @effect-diagnostics-next-line asyncFunction:off -- The Fetch API body reader is Promise-based.
      async () => await request.text()
    );

    if (!Option.contains(keyOfBody(body), config.value.key)) {
      return refuse(403);
    }

    const upstream = yield* Effect.promise(
      // @effect-diagnostics-next-line asyncFunction:off -- The Workers fetch API is Promise-based.
      async () =>
        await fetchUpstream(
          new Request(`${postHogHostOf(config.value)}${path}${url.search}`, {
            body,
            headers: { "content-type": "application/json" },
            method: "POST",
          })
        )
    );

    return new Response(upstream.body, {
      headers: {
        "cache-control": NO_STORE,
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      },
      status: upstream.status,
    });
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
        }),
        Effect.catchCause(() => Effect.succeed(response))
      );
