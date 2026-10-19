import { Billing, BillingUnavailable } from "@rat-stack/core";
import type { CheckoutRequest, PlanValue } from "@rat-stack/core";
import { Effect, Option } from "effect";

export interface CheckoutSessionRequest {
  readonly cancel_url: string;
  readonly client_reference_id: string;
  readonly customer?: string;
  readonly customer_email?: string;
  readonly line_items: { price: string; quantity: number }[];
  readonly metadata: Record<string, string>;
  readonly mode: "subscription";
  readonly subscription_data: { metadata: Record<string, string> };
  readonly success_url: string;
}

export interface PortalSessionRequest {
  readonly configuration: string;
  readonly customer: string;
  readonly return_url: string;
}

export interface StripeSessions<E> {
  readonly createCheckout: (
    request: CheckoutSessionRequest
  ) => Effect.Effect<{ readonly url?: string | null }, E>;
  readonly createPortal: (
    request: PortalSessionRequest
  ) => Effect.Effect<{ readonly url: string }, E>;
  readonly portalConfiguration: Effect.Effect<string>;
  readonly priceOf: (plan: PlanValue) => Effect.Effect<string>;
  readonly siteOrigin: string;
}

export const checkoutSessionRequest = (
  request: CheckoutRequest,
  price: string,
  siteOrigin: string
): CheckoutSessionRequest => {
  const metadata = { account_id: request.account.id };

  return {
    cancel_url: new URL("/pricing", siteOrigin).href,
    client_reference_id: request.account.id,
    ...Option.match(request.customer, {
      onNone: () => ({ customer_email: request.account.email }),
      onSome: (customer) => ({ customer }),
    }),
    line_items: [{ price, quantity: 1 }],
    metadata,
    mode: "subscription",
    subscription_data: { metadata },
    success_url: new URL("/account?checkout=done", siteOrigin).href,
  };
};

const unavailable = (step: string) => (cause: unknown) =>
  Effect.logWarning(`stripe ${step} failed`, cause).pipe(
    Effect.andThen(
      Effect.fail(
        new BillingUnavailable({
          message: "Billing is unavailable right now. Try again in a minute.",
        })
      )
    )
  );

export const makeBilling = <E>(sessions: StripeSessions<E>) =>
  Billing.of({
    checkout: (request) =>
      Effect.gen(function* checkout() {
        const price = yield* sessions.priceOf(request.plan);

        const session = yield* sessions
          .createCheckout(
            checkoutSessionRequest(request, price, sessions.siteOrigin)
          )
          .pipe(Effect.catch(unavailable("checkout")));

        return yield* Effect.fromOption(Option.fromNullishOr(session.url)).pipe(
          Effect.catch(unavailable("checkout url"))
        );
      }),
    portal: (customer) =>
      Effect.gen(function* portal() {
        const session = yield* sessions
          .createPortal({
            configuration: yield* sessions.portalConfiguration,
            customer,
            return_url: new URL("/account", sessions.siteOrigin).href,
          })
          .pipe(Effect.catch(unavailable("portal")));

        return session.url;
      }),
  });

const notOnSale = () =>
  Effect.fail(
    new BillingUnavailable({ message: "Pro is not on sale on this site yet." })
  );

export const billingOff = Billing.of({
  checkout: notOnSale,
  portal: notOnSale,
});
