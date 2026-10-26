import {
  billingOff,
  makeBilling,
  priceBook,
  ProCatalog,
  stripeKeyRefusal,
  stripeModeOf,
} from "@rat-stack/billing";
import type { ProPlanSettingValue, StripeEndpoint } from "@rat-stack/billing";
import * as RuntimeContext from "alchemy/RuntimeContext";
import * as Stripe from "alchemy/Stripe";
import { Effect, Option, Redacted } from "effect";

const NO_ENDPOINT = Effect.succeed(Option.none<StripeEndpoint>());

const profileKey = Effect.serviceOption(Stripe.Credentials).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.succeed(Option.none<Redacted.Redacted>()),
      onSome: (credentials) =>
        credentials.pipe(Effect.map(({ apiKey }) => Option.some(apiKey))),
    })
  )
);

export interface StripeHost {
  readonly hostId: string;
  readonly plans: readonly ProPlanSettingValue[];
  readonly restrictedKey: Option.Option<Redacted.Redacted>;
  readonly siteOrigin: Option.Option<string>;
  readonly stage: string;
}

export const stripeBilling = Effect.fn("stripeBilling")(function* stripeBilling(
  host: StripeHost
) {
  if (Option.isNone(host.siteOrigin) || host.plans.length === 0) {
    return { billing: billingOff, endpoint: NO_ENDPOINT };
  }

  if (globalThis.__ALCHEMY_RUNTIME__ !== true) {
    const refusal = stripeKeyRefusal(host.stage, {
      account: yield* profileKey,
      worker: host.restrictedKey,
    });

    if (Option.isSome(refusal)) {
      return yield* Effect.die(refusal.value);
    }
  }

  if (Option.isSome(host.restrictedKey)) {
    yield* Stripe.RestrictedApiKey(`${host.hostId}StripeToken`, {
      value: Redacted.value(host.restrictedKey.value),
    });
  }

  const siteOrigin = host.siteOrigin.value;
  const catalog = yield* ProCatalog(siteOrigin, host.plans);

  const book = priceBook(
    yield* Effect.all(
      catalog.prices.map(({ price, setting }) =>
        Effect.gen(function* catalogPrice() {
          return { priceId: yield* price.id, setting };
        })
      )
    )
  );

  const portalConfiguration = yield* catalog.portal.id;
  const secret = yield* catalog.webhook.secret;
  const createCheckout = yield* Stripe.CreateCheckoutSession();
  const createCustomer = yield* Stripe.CreateCustomer();
  const createPortal = yield* Stripe.CreateBillingPortalSession();

  return {
    billing: makeBilling({
      createCheckout: (request) =>
        createCheckout(request).pipe(
          Effect.provide(RuntimeContext.RuntimeContext.phantom)
        ),
      createCustomer: (request) =>
        createCustomer(request).pipe(
          Effect.provide(RuntimeContext.RuntimeContext.phantom)
        ),
      createPortal: (request) =>
        createPortal(request).pipe(
          Effect.provide(RuntimeContext.RuntimeContext.phantom)
        ),
      onSale: book.onSale,
      portalConfiguration,
      siteOrigin,
    }),
    endpoint: Effect.all({
      planPrices: Effect.all(
        book.entitled.map(([priceId, plan]) =>
          priceId.pipe(Effect.map((id) => [id, plan] as const))
        )
      ),
      secret,
    }).pipe(
      Effect.map(({ planPrices, secret: endpointSecret }) =>
        Option.map(
          Option.fromNullishOr(endpointSecret),
          (webhookSecret): StripeEndpoint => ({
            livemode: stripeModeOf(host.stage) === "live",
            prices: new Map(planPrices),
            secret: webhookSecret,
          })
        )
      )
    ),
  };
});
