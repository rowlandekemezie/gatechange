// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test reads the checked-in webhook fixtures once before any Effect runs.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { Account, AccountId, BillingChange } from "@rat-stack/core";
import {
  Data,
  Effect,
  Logger,
  Option,
  Predicate,
  Redacted,
  References,
  Schema,
} from "effect";

import {
  checkoutSessionRequest,
  customerRequest,
  billingChangeOf,
  PAST_DUE_GRACE_SECONDS,
  makeBilling,
  signatureHeader,
  signPayload,
  verifiedChange,
} from "../src/index.js";
import type { EventTerms, StripeEndpoint } from "../src/index.js";

const Fixtures = Schema.fromJsonString(Schema.Array(Schema.Unknown));

const payloads = Schema.decodeUnknownSync(Fixtures)(
  readFileSync(new URL("fixtures/pro-lifecycle.json", import.meta.url), "utf-8")
).map((event) => JSON.stringify(event));

const [checkout = "", created = "", cancelled = ""] = payloads;

const secret = Redacted.make("whsec_test_fixture_secret");

const SANDBOX_MONTHLY = "price_1USIFA0ZnafJYNlYo9bbbD97";

const sandbox: EventTerms = {
  livemode: false,
  prices: new Map([
    ["price_sandbox_weekly", "Weekly"],
    [SANDBOX_MONTHLY, "Monthly"],
    ["price_sandbox_yearly", "Yearly"],
  ]),
};

const endpoint: StripeEndpoint = { ...sandbox, secret };

const monthlyOnSale = {
  offer: {
    amountCents: 1900,
    interval: "month",
    intervalCount: 1,
    plan: "Monthly",
  },
  priceId: Effect.succeed("price_monthly"),
} as const;

class InvalidRequestError extends Data.TaggedError("InvalidRequestError")<{
  readonly message: string;
  readonly request_log_url: string | undefined;
}> {}

const NOW = 1_760_600_100_000;

const signed = (payload: string, at = NOW, key = secret) =>
  signPayload(key, Math.floor(at / 1000), payload).pipe(
    Effect.map((signature) => signatureHeader(Math.floor(at / 1000), signature))
  );

const changeOf = (payload: string, terms: EventTerms = sandbox) =>
  billingChangeOf(terms, payload);

const ada = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

describe("Stripe webhook signature", () => {
  it.effect("accepts a payload signed with the endpoint secret", () =>
    Effect.gen(function* accepts() {
      const header = yield* signed(created);
      const change = yield* verifiedChange(endpoint, created, header, NOW);

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
          Effect.flip(verifiedChange(endpoint, tampered, header, NOW)),
          Effect.flip(verifiedChange(endpoint, created, foreign, NOW)),
          Effect.flip(verifiedChange(endpoint, created, stale, NOW)),
          Effect.flip(verifiedChange(endpoint, created, "", NOW)),
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
        endpoint,
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
            customer: "cus_VTF3ozBrlTYb0Y",
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
            customer: "cus_VTF3ozBrlTYb0Y",
            subscription: {
              cancelAtPeriodEnd: true,
              periodEnd: 1_795_102_447_000,
              plan: "Monthly",
              status: "active",
              subscriptionId: "sub_1USIZh0ZnafJYNlY3wCgw7iV",
              version: {
                created: 1_792_424_262,
                eventId: "evt_1USId80ZnafJYNlY2e8Xj329",
                rank: 1,
              },
            },
          })
        );
      })
  );

  it.effect(
    "reads a portal cancellation sent as cancel_at with cancel_at_period_end false",
    () =>
      Effect.gen(function* cancelAt() {
        const change = yield* changeOf(cancelled);

        expect(
          Predicate.isTagged(change, "ApplySubscription")
            ? [
                cancelled.includes('"cancel_at_period_end":false'),
                change.subscription.cancelAtPeriodEnd,
              ]
            : null
        ).toEqual([true, true]);
      })
  );

  it.effect(
    "ends Pro at cancel_at when Stripe cancels before the period end",
    () =>
      Effect.gen(function* earlyCancel() {
        const early = created.replace(
          '"cancel_at":null',
          '"cancel_at":1793000000'
        );

        const change = yield* changeOf(early);

        expect(
          Predicate.isTagged(change, "ApplySubscription")
            ? [
                change.subscription.periodEnd,
                change.subscription.cancelAtPeriodEnd,
              ]
            : null
        ).toEqual([1_793_000_000_000, true]);
      })
  );

  it.effect(
    "keeps a past-due subscription on Pro for seven days from the failed renewal, not the whole new period",
    () =>
      Effect.gen(function* pastDue() {
        const failed = created.replace(
          '"status":"active"',
          '"status":"past_due"'
        );

        const changes = yield* Effect.all([
          changeOf(failed),
          changeOf(created),
        ]);

        expect(
          changes.map((change) =>
            Predicate.isTagged(change, "ApplySubscription")
              ? [change.subscription.status, change.subscription.periodEnd]
              : null
          )
        ).toEqual([
          ["past_due", (1_792_424_047 + PAST_DUE_GRACE_SECONDS) * 1000],
          ["active", 1_795_102_447_000],
        ]);
      })
  );

  it.effect(
    "grants the weekly plan from a configured weekly price id, whatever the price metadata says",
    () =>
      Effect.gen(function* byPrice() {
        const weekly = created.replaceAll(
          SANDBOX_MONTHLY,
          "price_sandbox_weekly"
        );

        const change = yield* changeOf(weekly);

        expect(
          Predicate.isTagged(change, "ApplySubscription")
            ? change.subscription.plan
            : null
        ).toBe("Weekly");
      })
  );

  it.effect(
    "ignores a subscription whose only price is not one of this stage's Pro prices",
    () =>
      Effect.gen(function* foreignPrice() {
        const foreign = created.replaceAll(
          SANDBOX_MONTHLY,
          "price_other_product"
        );

        expect(yield* changeOf(foreign)).toEqual(
          BillingChange.Ignore({ type: "customer.subscription.created" })
        );
      })
  );

  it.effect(
    "warns an operator when a subscription's price matches no configured plan",
    () =>
      Effect.gen(function* warnsUnknownPrice() {
        const entries: unknown[] = [];

        const foreign = created.replaceAll(
          SANDBOX_MONTHLY,
          "price_other_product"
        );

        yield* changeOf(foreign).pipe(
          Effect.provide(
            Logger.layer([
              Logger.make(({ fiber, logLevel, message }) =>
                entries.push({
                  fields: fiber.getRef(References.CurrentLogAnnotations),
                  logLevel,
                  message,
                })
              ),
            ])
          )
        );

        expect(entries).toStrictEqual([
          {
            fields: {
              eventId: "evt_1USIZj0ZnafJYNlYFqQEBJXC",
              priceIds: ["price_other_product"],
              subscriptionId: "sub_1USIZh0ZnafJYNlY3wCgw7iV",
            },
            logLevel: "Warn",
            message: ["stripe subscription price matches no plan"],
          },
        ]);
      })
  );

  it.effect("reads a Pro price listed after another product's item", () =>
    Effect.gen(function* secondItem() {
      const twoItems = created.replace(
        '"items":{"object":"list","data":[',
        '"items":{"object":"list","data":[{"price":{"id":"price_other_product"}},'
      );

      const change = yield* changeOf(twoItems);

      expect(change._tag).toBe("ApplySubscription");
    })
  );

  it.effect(
    "ignores a test-mode event on a live endpoint and a live event on a test endpoint",
    () =>
      Effect.gen(function* livemode() {
        const envelopeMode = created.lastIndexOf('"livemode":false');

        const live = `${created.slice(0, envelopeMode)}"livemode":true${created.slice(envelopeMode + '"livemode":false'.length)}`;

        const outcomes = yield* Effect.all([
          changeOf(created, { ...sandbox, livemode: true }),
          changeOf(checkout, { ...sandbox, livemode: true }),
          changeOf(live, sandbox),
          changeOf(live, { ...sandbox, livemode: true }),
        ]);

        expect(outcomes.map((outcome) => outcome._tag)).toEqual([
          "Ignore",
          "Ignore",
          "Ignore",
          "ApplySubscription",
        ]);
      })
  );

  it.effect("ignores event types it does not handle", () =>
    Effect.gen(function* ignores() {
      const invoice = JSON.stringify({
        created: 1,
        data: { object: { id: "in_1" } },
        id: "evt_invoice",
        livemode: false,
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
        livemode: false,
        type: "customer.subscription.updated",
      });

      const failure = yield* Effect.flip(changeOf(broken));

      expect(failure.reason).toBe("Malformed");
    })
  );
});

describe("checkout session request", () => {
  it("tags the session and the subscription with the member and bills their linked customer", () => {
    const request = checkoutSessionRequest(
      { account: ada, customer: "cus_TestAda", plan: "Yearly" },
      "price_yearly",
      "https://jobs.example"
    );

    expect(request).toEqual({
      cancel_url: "https://jobs.example/pricing",
      client_reference_id: "user_ada",
      customer: "cus_TestAda",
      line_items: [{ price: "price_yearly", quantity: 1 }],
      managed_payments: { enabled: false },
      metadata: { account_id: "user_ada" },
      mode: "subscription",
      subscription_data: { metadata: { account_id: "user_ada" } },
      success_url: "https://jobs.example/account?checkout=done",
    });
  });

  it("creates the member's Stripe customer with their email, name and account id", () => {
    expect(customerRequest(ada)).toEqual({
      email: "ada@example.com",
      metadata: { account_id: "user_ada" },
      name: "Ada",
    });
  });

  it.effect(
    "logs Stripe's refusal so an operator can see why checkout failed",
    () =>
      Effect.gen(function* logsRefusal() {
        const entries: unknown[] = [];

        const billing = makeBilling({
          createCheckout: () =>
            Effect.fail(
              new InvalidRequestError({
                message:
                  "Invalid line_items[0]: the product tax code is missing.",
                request_log_url: "https://dashboard.stripe.com/test/logs/req_1",
              })
            ),
          createCustomer: () => Effect.succeed({ id: "cus_TestAda" }),
          createPortal: () => Effect.succeed({ url: "https://portal.example" }),
          onSale: [monthlyOnSale],
          portalConfiguration: Effect.succeed("bpc_1"),
          siteOrigin: "https://jobs.example",
        });

        const failure = yield* billing
          .checkout({ account: ada, customer: "cus_TestAda", plan: "Monthly" })
          .pipe(
            Effect.flip,
            Effect.provide(
              Logger.layer([
                Logger.make(({ fiber, message }) =>
                  entries.push({
                    fields: fiber.getRef(References.CurrentLogAnnotations),
                    message,
                  })
                ),
              ])
            )
          );

        expect(failure._tag).toBe("BillingUnavailable");
        expect(entries).toStrictEqual([
          {
            fields: {
              stripeError: "InvalidRequestError",
              stripeMessage:
                "Invalid line_items[0]: the product tax code is missing.",
              stripeRequestLog: "https://dashboard.stripe.com/test/logs/req_1",
            },
            message: ["stripe checkout failed"],
          },
        ]);
      })
  );

  it.effect(
    "logs a refusal that has no request log, such as Stripe rejecting the API key",
    () =>
      Effect.gen(function* logsKeyRefusal() {
        const entries: unknown[] = [];

        const billing = makeBilling({
          createCheckout: () => Effect.succeed({ url: "https://pay.example" }),
          createCustomer: () =>
            Effect.fail(
              new InvalidRequestError({
                message:
                  "Invalid API Key provided: rk_test_***********************0000",
                request_log_url: undefined,
              })
            ),
          createPortal: () => Effect.succeed({ url: "https://portal.example" }),
          onSale: [monthlyOnSale],
          portalConfiguration: Effect.succeed("bpc_1"),
          siteOrigin: "https://jobs.example",
        });

        yield* billing
          .createCustomer(ada)
          .pipe(
            Effect.flip,
            Effect.provide(
              Logger.layer([
                Logger.make(({ fiber }) =>
                  entries.push(fiber.getRef(References.CurrentLogAnnotations))
                ),
              ])
            )
          );

        expect(entries).toStrictEqual([
          {
            stripeError: "InvalidRequestError",
            stripeMessage:
              "Invalid API Key provided: rk_test_***********************0000",
            stripeRequestLog: "none",
          },
        ]);
      })
  );
});
