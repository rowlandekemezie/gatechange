import type { AuthMilestone } from "@rat-stack/accounts";
import { AccountId, postHogHostOf } from "@rat-stack/core";
import type { AccountIdValue, PostHogConfigValue } from "@rat-stack/core";
import { Data, Effect, Option, Schema } from "effect";

export type ServerEventValue = Data.TaggedEnum<{
  DigestSent: { readonly count: number };
  EmailUnsubscribed: { readonly account: AccountIdValue };
  McpToolCalled: { readonly tool: string };
  SignedIn: { readonly account: AccountIdValue; readonly method: string };
  SignedUp: { readonly account: AccountIdValue; readonly method: string };
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
    EmailUnsubscribed: ({ account }) => ({
      distinct_id: account,
      event: "email_unsubscribed",
      properties: {},
    }),
    McpToolCalled: ({ tool }) => ({
      distinct_id: SERVER_DISTINCT_ID,
      event: "mcp_tool_called",
      properties: { tool },
    }),
    SignedIn: ({ account, method }) => ({
      distinct_id: account,
      event: "signin_completed",
      properties: { method },
    }),
    SignedUp: ({ account, method }) => ({
      distinct_id: account,
      event: "signup_completed",
      properties: { method },
    }),
    SubscriptionActivated: ({ account }) => ({
      distinct_id: account,
      event: "subscription_activated",
      properties: { $process_person_profile: true },
    }),
  }),
});

export const privacySignalled = (
  headers: Readonly<Record<string, string | undefined>>
) => headers.dnt === "1" || headers["sec-gpc"] === "1";

export const milestoneEvent = ({
  account,
  headers,
  kind,
  method,
}: AuthMilestone): Option.Option<ServerEventValue> =>
  privacySignalled(headers)
    ? Option.none()
    : Option.map(Schema.decodeOption(AccountId)(account), (id) =>
        ServerEvent[kind]({ account: id, method })
      );

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
          Effect.timeout("5 seconds"),
          Effect.tapError((failure) =>
            Effect.logWarning("analytics capture failed", failure)
          ),
          Effect.ignore
        );
      },
    });
