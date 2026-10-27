import { postHogHostOf } from "@rat-stack/core";
import type { AccountIdValue, PostHogConfigValue } from "@rat-stack/core";
import { Data, Effect, Option } from "effect";

export type ServerEventValue = Data.TaggedEnum<{
  DigestSent: { readonly count: number };
  McpToolCalled: { readonly tool: string };
  SubscriptionActivated: { readonly account: AccountIdValue };
}>;

export const ServerEvent = Data.taggedEnum<ServerEventValue>();

const SERVER_DISTINCT_ID = "jobs-api";

export const captureBodyOf = (key: string, event: ServerEventValue) => ({
  api_key: key,
  ...ServerEvent.$match(event, {
    DigestSent: ({ count }) => ({
      distinct_id: SERVER_DISTINCT_ID,
      event: "digest_sent",
      properties: { count },
    }),
    McpToolCalled: ({ tool }) => ({
      distinct_id: SERVER_DISTINCT_ID,
      event: "mcp_tool_called",
      properties: { tool },
    }),
    SubscriptionActivated: ({ account }) => ({
      distinct_id: account,
      event: "subscription_activated",
      properties: { $process_person_profile: true },
    }),
  }),
});

export type Capture = (event: ServerEventValue) => Effect.Effect<void>;

export type CaptureUpstream = (
  url: string,
  init: {
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly method: "POST";
  }
) => Promise<Response>;

export const postHogCapture =
  (
    config: Option.Option<PostHogConfigValue>,
    upstream: CaptureUpstream
  ): Capture =>
  (event) =>
    Option.match(config, {
      onNone: () => Effect.void,
      onSome: (posthog) => {
        const body = captureBodyOf(posthog.key, event);

        return Effect.tryPromise(
          // @effect-diagnostics-next-line asyncFunction:off -- The Workers fetch API is Promise-based.
          async () =>
            await upstream(`${postHogHostOf(posthog)}/i/v0/e/`, {
              body: JSON.stringify({
                ...body,
                properties: {
                  $geoip_disable: true,
                  $lib: "jobs-api",
                  $process_person_profile: false,
                  ...body.properties,
                },
              }),
              headers: { "content-type": "application/json" },
              method: "POST",
            })
        ).pipe(
          Effect.tapError((failure) =>
            Effect.logWarning("analytics capture failed", failure)
          ),
          Effect.ignore
        );
      },
    });
