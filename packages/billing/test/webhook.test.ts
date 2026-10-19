// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test reads the checked-in webhook fixtures once before any Effect runs.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { Account, AccountId, BillingChange } from "@rat-stack/core";
import { Effect, Option, Predicate, Redacted, Schema } from "effect";

import {
  checkoutSessionRequest,
  billingChangeOf,
  signatureHeader,
  signPayload,
  verifiedChange,
} from "../src/index.js";

const Fixtures = Schema.fromJsonString(Schema.Array(Schema.Unknown));

const payloads = Schema.decodeUnknownSync(Fixtures)(
  readFileSync(new URL("fixtures/pro-lifecycle.json", import.meta.url), "utf-8")
).map((event) => JSON.stringify(event));

const [checkout = "", created = "", cancelled = ""] = payloads;

const secret = Redacted.make("whsec_test_fixture_secret");

const NOW = 1_760_600_100_000;

const signed = (payload: string, at = NOW, key = secret) =>
  signPayload(key, Math.floor(at / 1000), payload).pipe(
    Effect.map((signature) => signatureHeader(Math.floor(at / 1000), signature))
  );

const changeOf = billingChangeOf;

const ada = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

describe("Stripe webhook signature", () => {
  it.effect("accepts a payload signed with the endpoint secret", () =>
    Effect.gen(function* accepts() {
      const header = yield* signed(created);
      const change = yield* verifiedChange(secret, created, header, NOW);

      expect(change._tag).toBe("ApplySubscription");
    })
  );

  it.effect(
    "rejects a tampered payload, a foreign secret, a stale timestamp, and a missing header",
    () =>
      Effect.gen(function* rejects() {
        const header = yield* signed(created);

        const foreign = yield* signed(
          created,
          NOW,
          Redacted.make("whsec_someone_else")
        );

        const stale = yield* signed(created, NOW - 10 * 60 * 1000);

        const tampered = created.replace(
          '"status":"active"',
          '"status":"trialing"'
        );

        const failures = yield* Effect.all([
          Effect.flip(verifiedChange(secret, tampered, header, NOW)),
          Effect.flip(verifiedChange(secret, created, foreign, NOW)),
          Effect.flip(verifiedChange(secret, created, stale, NOW)),
          Effect.flip(verifiedChange(secret, created, "", NOW)),
        ]);

        expect(failures.map((failure) => failure.reason)).toEqual([
          "BadSignature",
          "BadSignature",
          "BadSignature",
          "BadSignature",
        ]);
      })
  );

  it.effect("accepts any of several v1 signatures during secret rotation", () =>
    Effect.gen(function* rotation() {
      const at = Math.floor(NOW / 1000);
      const old = yield* signPayload(Redacted.make("whsec_old"), at, created);
      const current = yield* signPayload(secret, at, created);

      const change = yield* verifiedChange(
        secret,
        created,
        `t=${at},v1=${old},v1=${current}`,
        NOW
      );

      expect(change._tag).toBe("ApplySubscription");
    })
  );
});

describe("Stripe events to billing changes", () => {
  it.effect(
    "links the checkout customer to the member it was started for",
    () =>
      Effect.gen(function* links() {
        expect(yield* changeOf(checkout)).toEqual(
          BillingChange.LinkCustomer({
            account: AccountId.make("user_ada"),
            customer: "cus_TestAda",
          })
        );
      })
  );

  it.effect(
    "reads the account, plan, period end, and event version from a subscription event",
    () =>
      Effect.gen(function* reads() {
        expect(yield* changeOf(cancelled)).toEqual(
          BillingChange.ApplySubscription({
            account: Option.some(AccountId.make("user_ada")),
            customer: "cus_TestAda",
            subscription: {
              cancelAtPeriodEnd: true,
              periodEnd: 1_763_278_400_000,
              plan: "Monthly",
              status: "active",
              subscriptionId: "sub_1SJAda",
              version: {
                created: 1_760_686_400,
                eventId: "evt_1SJ03cancelAda",
                rank: 1,
              },
            },
          })
        );
      })
  );

  it.effect(
    "falls back to the price interval when the price has no plan metadata",
    () =>
      Effect.gen(function* interval() {
        const quarterly = created
          .replace('"metadata":{"plan":"Monthly"}', '"metadata":{}')
          .replace('"interval_count":1', '"interval_count":3');

        const change = yield* changeOf(quarterly);

        expect(
          Predicate.isTagged(change, "ApplySubscription")
            ? change.subscription.plan
            : null
        ).toBe("Quarterly");
      })
  );

  it.effect("ignores event types it does not handle", () =>
    Effect.gen(function* ignores() {
      const invoice = JSON.stringify({
        created: 1,
        data: { object: { id: "in_1" } },
        id: "evt_invoice",
        type: "invoice.paid",
      });

      expect(yield* changeOf(invoice)).toEqual(
        BillingChange.Ignore({ type: "invoice.paid" })
      );
    })
  );

  it.effect("rejects a handled event whose object is not a subscription", () =>
    Effect.gen(function* malformed() {
      const broken = JSON.stringify({
        created: 1,
        data: { object: { id: "sub_1" } },
        id: "evt_broken",
        type: "customer.subscription.updated",
      });

      const failure = yield* Effect.flip(changeOf(broken));

      expect(failure.reason).toBe("Malformed");
    })
  );
});

describe("checkout session request", () => {
  it("tags the session and the subscription with the member and asks a new buyer for their email", () => {
    const request = checkoutSessionRequest(
      { account: ada, customer: Option.none(), plan: "Yearly" },
      "price_yearly",
      "https://jobs.example"
    );

    expect(request).toEqual({
      cancel_url: "https://jobs.example/pricing",
      client_reference_id: "user_ada",
      customer_email: "ada@example.com",
      line_items: [{ price: "price_yearly", quantity: 1 }],
      metadata: { account_id: "user_ada" },
      mode: "subscription",
      subscription_data: { metadata: { account_id: "user_ada" } },
      success_url: "https://jobs.example/account?checkout=done",
    });
  });

  it("reuses the member's Stripe customer on a return visit", () => {
    const request = checkoutSessionRequest(
      { account: ada, customer: Option.some("cus_TestAda"), plan: "Monthly" },
      "price_monthly",
      "https://jobs.example"
    );

    expect([request.customer, request.customer_email]).toEqual([
      "cus_TestAda",
      undefined,
    ]);
  });
});
