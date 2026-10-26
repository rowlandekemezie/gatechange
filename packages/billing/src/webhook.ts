import { AccountId, BillingChange, SubscriptionStatus } from "@rat-stack/core";
import type { BillingChangeValue, PlanValue } from "@rat-stack/core";
import { Array, Data, Effect, Option, Redacted, Schema } from "effect";

export const STRIPE_WEBHOOK_PATH = "/webhooks/stripe";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const PAST_DUE_GRACE_SECONDS = 7 * 24 * 60 * 60;

const CHECKOUT_COMPLETED = "checkout.session.completed";

const SubscriptionEventType = Schema.Literals([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

export const BILLING_EVENTS = [
  CHECKOUT_COMPLETED,
  ...SubscriptionEventType.literals,
] as const;

export class WebhookRejected extends Data.TaggedError("WebhookRejected")<{
  readonly reason: "BadSignature" | "Malformed";
}> {}

const encoder = new TextEncoder();

const SHA256_HEX = /^[0-9a-f]{64}$/u;

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const bytesOfHex = (text: string): Option.Option<Uint8Array> =>
  SHA256_HEX.test(text)
    ? Option.some(
        Uint8Array.from({ length: text.length / 2 }, (_, index) =>
          Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
        )
      )
    : Option.none();

// @effect-diagnostics-next-line asyncFunction:off -- WebCrypto imports keys only through Promises.
const hmacKey = async (secret: Redacted.Redacted, usage: "sign" | "verify") =>
  await crypto.subtle.importKey(
    "raw",
    encoder.encode(Redacted.value(secret)),
    { hash: "SHA-256", name: "HMAC" },
    false,
    [usage]
  );

const signedContent = (timestamp: number, payload: string) =>
  encoder.encode(`${timestamp}.${payload}`);

export const signPayload = (
  secret: Redacted.Redacted,
  timestamp: number,
  payload: string
) =>
  // @effect-diagnostics-next-line asyncFunction:off -- WebCrypto exposes HMAC only through Promises.
  Effect.promise(async () =>
    hex(
      await crypto.subtle.sign(
        "HMAC",
        await hmacKey(secret, "sign"),
        signedContent(timestamp, payload)
      )
    )
  );

const signatureParts = (header: string) => {
  const pairs = header.split(",").map((part) => {
    const separator = part.indexOf("=");

    return {
      key: part.slice(0, separator).trim(),
      value: part.slice(separator + 1).trim(),
    };
  });

  return {
    signatures: Array.getSomes(
      pairs.flatMap(({ key, value }) =>
        key === "v1" ? [bytesOfHex(value)] : []
      )
    ),
    timestamp: Number(
      pairs.find(({ key }) => key === "t")?.value ?? Number.NaN
    ),
  };
};

const anySignatureMatches = (
  secret: Redacted.Redacted,
  timestamp: number,
  payload: string,
  signatures: readonly Uint8Array[]
) =>
  // @effect-diagnostics-next-line asyncFunction:off -- WebCrypto exposes HMAC only through Promises.
  Effect.promise(async () => {
    const key = await hmacKey(secret, "verify");
    const content = signedContent(timestamp, payload);
    let matched = false;

    for (const signature of signatures) {
      // oxlint-disable-next-line no-await-in-loop -- Stripe sends at most a couple of v1 signatures, and the first match ends the check.
      matched ||= await crypto.subtle.verify("HMAC", key, signature, content);
    }

    return matched;
  });

export const verifySignature = Effect.fn("verifyStripeSignature")(
  function* verifySignature(
    secret: Redacted.Redacted,
    payload: string,
    header: string,
    nowMillis: number
  ) {
    const { signatures, timestamp } = signatureParts(header);

    const isFresh =
      Number.isInteger(timestamp) &&
      Math.abs(nowMillis / 1000 - timestamp) <= SIGNATURE_TOLERANCE_SECONDS;

    const isSigned =
      isFresh && Array.isReadonlyArrayNonEmpty(signatures)
        ? yield* anySignatureMatches(secret, timestamp, payload, signatures)
        : false;

    return yield* isSigned
      ? Effect.void
      : Effect.fail(new WebhookRejected({ reason: "BadSignature" }));
  }
);

export const signatureHeader = (timestamp: number, signature: string) =>
  `t=${timestamp},v1=${signature}`;

const Metadata = Schema.Record(Schema.String, Schema.String);

const SubscriptionItem = Schema.Struct({
  current_period_end: Schema.optionalKey(Schema.Int),
  current_period_start: Schema.optionalKey(Schema.Int),
  price: Schema.Struct({ id: Schema.NonEmptyString }),
});

const SubscriptionObject = Schema.Struct({
  cancel_at: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  cancel_at_period_end: Schema.Boolean,
  current_period_end: Schema.optionalKey(Schema.Int),
  current_period_start: Schema.optionalKey(Schema.Int),
  customer: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  items: Schema.Struct({ data: Schema.Array(SubscriptionItem) }),
  metadata: Metadata,
  status: SubscriptionStatus,
});

const CheckoutSessionObject = Schema.Struct({
  client_reference_id: Schema.NullOr(Schema.String),
  customer: Schema.NullOr(Schema.String),
  mode: Schema.String,
});

const Envelope = Schema.Struct({
  created: Schema.Int,
  id: Schema.NonEmptyString,
  livemode: Schema.Boolean,
  type: Schema.String,
});

const SubscriptionEvent = Schema.Struct({
  ...Envelope.fields,
  data: Schema.Struct({ object: SubscriptionObject }),
  type: SubscriptionEventType,
});

const CheckoutEvent = Schema.Struct({
  ...Envelope.fields,
  data: Schema.Struct({ object: CheckoutSessionObject }),
  type: Schema.Literal(CHECKOUT_COMPLETED),
});

const malformed = () => new WebhookRejected({ reason: "Malformed" });

const decodeEnvelope = Schema.decodeEffect(Schema.fromJsonString(Envelope));

const decodeSubscription = Schema.decodeEffect(
  Schema.fromJsonString(SubscriptionEvent)
);

const decodeCheckout = Schema.decodeEffect(
  Schema.fromJsonString(CheckoutEvent)
);

export interface StripeEndpoint {
  readonly livemode: boolean;
  readonly prices: ReadonlyMap<string, PlanValue>;
  readonly secret: Redacted.Redacted;
}

export type EventTerms = Pick<StripeEndpoint, "livemode" | "prices">;

const subscriptionChangeOf = Effect.fn("subscriptionChangeOf")(
  function* subscriptionChangeOf(
    terms: EventTerms,
    event: typeof SubscriptionEvent.Type
  ): Effect.fn.Return<BillingChangeValue> {
    const subscription = event.data.object;

    const priced = Array.findFirst(subscription.items.data, (item) =>
      Option.fromNullishOr(terms.prices.get(item.price.id)).pipe(
        Option.map((plan) => ({ item, plan }))
      )
    );

    const periodEnd = Option.fromNullishOr(
      subscription.current_period_end ??
        Option.getOrUndefined(priced)?.item.current_period_end
    );

    if (Option.isNone(priced)) {
      yield* Effect.logWarning(
        "stripe subscription price matches no plan"
      ).pipe(
        Effect.annotateLogs({
          eventId: event.id,
          priceIds: subscription.items.data.map((entry) => entry.price.id),
          subscriptionId: subscription.id,
        })
      );

      return BillingChange.Ignore({ type: event.type });
    }

    if (Option.isNone(periodEnd)) {
      return BillingChange.Ignore({ type: event.type });
    }

    const { item, plan } = priced.value;

    const cancelAt = subscription.cancel_at ?? null;

    const periodStart =
      subscription.current_period_start ?? item.current_period_start;

    const graceEnd =
      subscription.status === "past_due" && periodStart !== undefined
        ? periodStart + PAST_DUE_GRACE_SECONDS
        : Number.POSITIVE_INFINITY;

    return BillingChange.ApplySubscription({
      account: Schema.decodeUnknownOption(AccountId)(
        subscription.metadata.account_id
      ),
      customer: subscription.customer,
      subscription: {
        cancelAtPeriodEnd:
          subscription.cancel_at_period_end || cancelAt !== null,
        periodEnd:
          Math.min(
            periodEnd.value,
            cancelAt ?? Number.POSITIVE_INFINITY,
            graceEnd
          ) * 1000,
        plan,
        status: subscription.status,
        subscriptionId: subscription.id,
        version: {
          created: event.created,
          eventId: event.id,
          rank: SubscriptionEventType.literals.indexOf(event.type),
        },
      },
    });
  }
);

const checkoutChangeOf = (
  event: typeof CheckoutEvent.Type
): BillingChangeValue => {
  const session = event.data.object;

  const account = Schema.decodeUnknownOption(AccountId)(
    session.client_reference_id
  );

  return session.mode === "subscription" &&
    Option.isSome(account) &&
    session.customer !== null &&
    session.customer !== ""
    ? BillingChange.LinkCustomer({
        account: account.value,
        customer: session.customer,
      })
    : BillingChange.Ignore({ type: event.type });
};

export const billingChangeOf = Effect.fn("billingChangeOf")(
  function* billingChangeOf(terms: EventTerms, payload: string) {
    const { livemode, type } = yield* decodeEnvelope(payload).pipe(
      Effect.mapError(malformed)
    );

    if (livemode !== terms.livemode) {
      return BillingChange.Ignore({ type });
    }

    if (type === CHECKOUT_COMPLETED) {
      return checkoutChangeOf(
        yield* decodeCheckout(payload).pipe(Effect.mapError(malformed))
      );
    }

    if (Schema.is(SubscriptionEventType)(type)) {
      return yield* subscriptionChangeOf(
        terms,
        yield* decodeSubscription(payload).pipe(Effect.mapError(malformed))
      );
    }

    return BillingChange.Ignore({ type });
  }
);

export const verifiedChange = Effect.fn("verifiedBillingChange")(
  function* verifiedChange(
    endpoint: StripeEndpoint,
    payload: string,
    header: string,
    nowMillis: number
  ) {
    yield* verifySignature(endpoint.secret, payload, header, nowMillis);

    return yield* billingChangeOf(endpoint, payload);
  }
);
