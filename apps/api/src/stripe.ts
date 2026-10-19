import { billingOff, makeBilling, ProCatalog } from "@rat-stack/billing";
import type { StripeEndpoint } from "@rat-stack/billing";
import { PROD_STAGE } from "@rat-stack/core";
import type { PlanValue } from "@rat-stack/core";
import * as RuntimeContext from "alchemy/RuntimeContext";
import * as Stripe from "alchemy/Stripe";
import { Effect, Option } from "effect";

const NO_ENDPOINT = Effect.succeed(Option.none<StripeEndpoint>());

export const stripeBilling = Effect.fn("stripeBilling")(function* stripeBilling(
  stage: string,
  siteOrigin: Option.Option<string>
) {
  if (Option.isNone(siteOrigin)) {
    return { billing: billingOff, endpoint: NO_ENDPOINT };
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
    endpoint: Effect.all({
      Monthly: prices.Monthly,
      Quarterly: prices.Quarterly,
      Yearly: prices.Yearly,
      secret,
    }).pipe(
      Effect.map(({ secret: endpointSecret, ...planPrices }) =>
        Option.map(
          Option.fromNullishOr(endpointSecret),
          (webhookSecret): StripeEndpoint => ({
            livemode: stage === PROD_STAGE,
            prices: planPrices,
            secret: webhookSecret,
          })
        )
      )
    ),
  };
});
