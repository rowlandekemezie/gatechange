import { Billing, BillingUnavailable } from "@rat-stack/core";
import type {
  AccountValue,
  CheckoutRequest,
  PlanOfferValue,
} from "@rat-stack/core";
import { Array, Effect, Option, Schema } from "effect";

export interface CheckoutSessionRequest {
  readonly cancel_url: string;
  readonly client_reference_id: string;
  readonly customer: string;
  readonly line_items: { price: string; quantity: number }[];
  readonly managed_payments: { enabled: boolean };
  readonly metadata: Record<string, string>;
  readonly mode: "subscription";
  readonly subscription_data: { metadata: Record<string, string> };
  readonly success_url: string;
}

export interface CustomerRequest {
  readonly email: string;
  readonly metadata: Record<string, string>;
  readonly name: string;
}

export interface PortalSessionRequest {
  readonly configuration: string;
  readonly customer: string;
  readonly return_url: string;
}

export interface SalePrice {
  readonly offer: PlanOfferValue;
  readonly priceId: Effect.Effect<string>;
}

export interface StripeSessions<E> {
  readonly createCheckout: (
    request: CheckoutSessionRequest
  ) => Effect.Effect<{ readonly url?: string | null }, E>;
  readonly createCustomer: (
    request: CustomerRequest
  ) => Effect.Effect<{ readonly id: string }, E>;
  readonly createPortal: (
    request: PortalSessionRequest
  ) => Effect.Effect<{ readonly url: string }, E>;
  readonly onSale: readonly SalePrice[];
  readonly portalConfiguration: Effect.Effect<string>;
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
    customer: request.customer,
    line_items: [{ price, quantity: 1 }],
    managed_payments: { enabled: false },
    metadata,
    mode: "subscription",
    subscription_data: { metadata },
    success_url: new URL("/account?checkout=done", siteOrigin).href,
  };
};

const StripeRefusal = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  request_log_url: Schema.optional(Schema.String),
});

const unavailable = (step: string) => (cause: unknown) => {
  const refusal = Option.getOrUndefined(
    Schema.decodeUnknownOption(StripeRefusal)(cause)
  );

  return Effect.logWarning(`stripe ${step} failed`).pipe(
    Effect.annotateLogs({
      stripeError: refusal?._tag ?? "unknown",
      stripeMessage: refusal?.message ?? "unknown",
      stripeRequestLog: refusal?.request_log_url ?? "none",
    }),
    Effect.andThen(
      Effect.fail(
        new BillingUnavailable({
          message: "Billing is unavailable right now. Try again in a minute.",
        })
      )
    )
  );
};

export const customerRequest = (account: AccountValue): CustomerRequest => ({
  email: account.email,
  metadata: { account_id: account.id },
  name: account.name,
});

export const makeBilling = <E>(sessions: StripeSessions<E>) =>
  Billing.of({
    checkout: (request) =>
      Effect.gen(function* checkout() {
        const sale = yield* Effect.fromOption(
          Array.findFirst(
            sessions.onSale,
            ({ offer }) => offer.plan === request.plan
          )
        ).pipe(
          Effect.mapError(
            () =>
              new BillingUnavailable({ message: "That plan is not on sale." })
          )
        );

        const price = yield* sale.priceId;

        const session = yield* sessions
          .createCheckout(
            checkoutSessionRequest(request, price, sessions.siteOrigin)
          )
          .pipe(Effect.catch(unavailable("checkout")));

        return yield* Effect.fromOption(Option.fromNullishOr(session.url)).pipe(
          Effect.catch(unavailable("checkout url"))
        );
      }),
    createCustomer: (account) =>
      Effect.gen(function* createCustomer() {
        const customer = yield* sessions
          .createCustomer(customerRequest(account))
          .pipe(Effect.catch(unavailable("customer")));

        return customer.id;
      }),
    plans: sessions.onSale.map(({ offer }) => offer),
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
  createCustomer: notOnSale,
  plans: [],
  portal: notOnSale,
});
