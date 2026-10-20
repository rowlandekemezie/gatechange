import { describe, expect, it } from "@effect/vitest";
import { Option, Redacted } from "effect";

import { stripeKeyRefusal } from "../src/index.js";
import type { StripeKeys } from "../src/index.js";

const key = (value: string) => Option.some(Redacted.make(value));

const keys = (account: string | null, worker: string | null): StripeKeys => ({
  account: account === null ? Option.none() : key(account),
  worker: worker === null ? Option.none() : key(worker),
});

const refused = (stage: string, stripeKeys: StripeKeys) =>
  Option.match(stripeKeyRefusal(stage, stripeKeys), {
    onNone: () => "deploys",
    onSome: (refusal) => refusal.message,
  });

describe("Stripe keys a stage may deploy with", () => {
  it("refuses prod billing without a restricted key, so the Worker never gets the account secret", () => {
    expect(refused("prod", keys("sk_live_account", null))).toContain(
      "STRIPE_RESTRICTED_KEY"
    );
  });

  it("refuses prod billing with a test-mode profile key or a test-mode restricted key", () => {
    expect([
      refused("prod", keys("sk_test_account", "rk_live_worker")),
      refused("prod", keys("rk_test_account", "rk_live_worker")),
      refused("prod", keys("sk_live_account", "rk_test_worker")),
      refused("prod", keys("sk_live_account", "sk_test_worker")),
    ]).toEqual([
      "The Alchemy Stripe profile key is a test-mode key, but stage prod sells in live mode.",
      "The Alchemy Stripe profile key is a test-mode key, but stage prod sells in live mode.",
      "STRIPE_RESTRICTED_KEY is a test-mode key, but stage prod sells in live mode.",
      "STRIPE_RESTRICTED_KEY is a test-mode key, but stage prod sells in live mode.",
    ]);
  });

  it("refuses an account secret passed off as the prod restricted key", () => {
    expect(refused("prod", keys("sk_live_account", "sk_live_worker"))).toBe(
      "Stage prod needs a restricted rk_live_ key in STRIPE_RESTRICTED_KEY, not a secret key."
    );
  });

  it("deploys prod with a live profile key and an rk_live_ restricted key", () => {
    expect(refused("prod", keys("sk_live_account", "rk_live_worker"))).toBe(
      "deploys"
    );
  });

  it("refuses live keys on every other stage and accepts test keys there", () => {
    expect([
      refused("verify-j10-r4", keys("sk_live_account", null)),
      refused("verify-j10-r4", keys("sk_test_account", "rk_live_worker")),
      refused("verify-j10-r4", keys("sk_test_account", null)),
      refused("verify-j10-r4", keys("sk_test_account", "rk_test_worker")),
      refused("verify-j10-r4", keys(null, null)),
    ]).toEqual([
      "The Alchemy Stripe profile key is a live-mode key, but stage verify-j10-r4 sells in test mode.",
      "STRIPE_RESTRICTED_KEY is a live-mode key, but stage verify-j10-r4 sells in test mode.",
      "deploys",
      "deploys",
      "deploys",
    ]);
  });

  it("refuses values that are not Stripe API keys", () => {
    expect([
      refused("verify-j10-r4", keys("pk_test_publishable", null)),
      refused("verify-j10-r4", keys("sk_test_account", "whsec_123")),
    ]).toEqual([
      "The Alchemy Stripe profile key is not an sk_ or rk_ Stripe key.",
      "STRIPE_RESTRICTED_KEY is not a Stripe API key.",
    ]);
  });
});
