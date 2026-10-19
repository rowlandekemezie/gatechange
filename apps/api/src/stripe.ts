import { billingOff, makeBilling, ProCatalog } from "@rat-stack/billing";
import type { PlanValue } from "@rat-stack/core";
import * as RuntimeContext from "alchemy/RuntimeContext";
import * as Stripe from "alchemy/Stripe";
import { Effect, Option } from "effect";
import type { Redacted } from "effect";

const NO_WEBHOOK_SECRET = Effect.succeed(Option.none<Redacted.Redacted>());

export const stripeBilling = Effect.fn("stripeBilling")(function* stripeBilling(
  siteOrigin: Option.Option<string>
) {
  if (Option.isNone(siteOrigin)) {
    return { billing: billingOff, webhookSecret: NO_WEBHOOK_SECRET };
  }

  const catalog = yield* ProCatalog(siteOrigin.value);

  const prices: Record<PlanValue, Effect.Effect<string>> = {
    Monthly: yield* catalog.prices.Monthly.id,
    Quarterly: yield* catalog.prices.Quarterly.id,
    Yearly: yield* catalog.prices.Yearly.id,
  };

  const portalConfiguration = yield* catalog.portal.id;
  const secret = yield* catalog.webhook.secret;
  const createCheckout = yield* Stripe.CreateCheckoutSession();
  const createPortal = yield* Stripe.CreateBillingPortalSession();

  return {
    billing: makeBilling({
      createCheckout: (request) =>
        createCheckout(request).pipe(
          Effect.provide(RuntimeContext.RuntimeContext.phantom)
        ),
      createPortal: (request) =>
        createPortal(request).pipe(
          Effect.provide(RuntimeContext.RuntimeContext.phantom)
        ),
      portalConfiguration,
      priceOf: (plan) => prices[plan],
      siteOrigin: siteOrigin.value,
    }),
    webhookSecret: secret.pipe(Effect.map(Option.fromNullishOr)),
  };
});
