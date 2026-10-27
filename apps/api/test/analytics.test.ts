// @effect-diagnostics asyncFunction:off -- The stubbed fetch is Promise-based.
import { describe, expect, it } from "@effect/vitest";
import { AccountId, postHogSetting } from "@rat-stack/core";
import { ConfigProvider, Effect, Option, Schema } from "effect";
import { vi } from "vitest";

import { postHogCapture, ServerEvent } from "../src/analytics.js";
import type { CaptureUpstream } from "../src/analytics.js";

const KEY = "phc_testProjectKey123";

const settingOf = (values: Record<string, string>) =>
  postHogSetting.parse(ConfigProvider.fromUnknown(values));

const accepting = () =>
  vi.fn<CaptureUpstream>(async () => await Promise.resolve(new Response("{}")));

const ada = Schema.decodeSync(AccountId)("user_ada");

describe("server analytics", () => {
  it.effect("is off when the variables are unset or empty", () =>
    Effect.gen(function* unset() {
      expect(yield* settingOf({})).toStrictEqual(Option.none());
      expect(
        yield* settingOf({ POSTHOG_PROJECT_KEY: "", POSTHOG_REGION: "" })
      ).toStrictEqual(Option.none());
    })
  );

  it.effect("refuses a key that is not a project key", () =>
    Effect.gen(function* personalKey() {
      const parsed = yield* Effect.result(
        settingOf({ POSTHOG_PROJECT_KEY: "phx_personal", POSTHOG_REGION: "eu" })
      );

      expect(parsed._tag).toBe("Failure");
    })
  );

  it.effect("sends nothing without config", () =>
    Effect.gen(function* noOp() {
      const upstream = accepting();

      yield* postHogCapture(
        Option.none(),
        upstream
      )(ServerEvent.McpToolCalled({ tool: "listJobs" }));

      expect(upstream).not.toHaveBeenCalled();
    })
  );

  it.effect("captures to the region host and identifies members by id", () =>
    Effect.gen(function* captured() {
      const upstream = accepting();

      const setting = yield* settingOf({
        POSTHOG_PROJECT_KEY: KEY,
        POSTHOG_REGION: "eu",
      });

      yield* postHogCapture(
        setting,
        upstream
      )(
        ServerEvent.SubscriptionActivated({
          account: ada,
        })
      );

      const [url, init] = upstream.mock.calls[0] ?? [];

      const body: unknown = JSON.parse(init?.body ?? "null");

      expect(url).toBe("https://eu.i.posthog.com/i/v0/e/");
      expect(body).toMatchObject({
        api_key: KEY,
        distinct_id: "user_ada",
        event: "subscription_activated",
        properties: { $process_person_profile: true },
      });
    })
  );

  it.effect("never fails the caller when PostHog is unreachable", () =>
    Effect.gen(function* unreachable() {
      const setting = yield* settingOf({
        POSTHOG_PROJECT_KEY: KEY,
        POSTHOG_REGION: "us",
      });

      yield* postHogCapture(setting, async () => {
        await Promise.resolve();

        throw new Error("network down");
      })(ServerEvent.DigestSent({ count: 3 }));
    })
  );
});
