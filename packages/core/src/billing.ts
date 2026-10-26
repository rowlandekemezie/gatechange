import { Clock, Context, Data, Effect, Option } from "effect";

import type { AccountIdValue, AccountValue } from "./account.js";
import { BillingStore } from "./billing-store.js";
import type { BillingUnavailable } from "./billing-unavailable.js";
import { entitlementOf } from "./entitlement.js";
import type {
  PlanOfferValue,
  PlanValue,
  SubscriptionRecordValue,
} from "./entitlement.js";

export interface CheckoutRequest {
  readonly account: AccountValue;
  readonly customer: string;
  readonly plan: PlanValue;
}

export class Billing extends Context.Service<
  Billing,
  {
    readonly checkout: (
      request: CheckoutRequest
    ) => Effect.Effect<string, BillingUnavailable>;
    readonly createCustomer: (
      account: AccountValue
    ) => Effect.Effect<string, BillingUnavailable>;
    readonly plans: readonly PlanOfferValue[];
    readonly portal: (
      customer: string
    ) => Effect.Effect<string, BillingUnavailable>;
  }
>()("@rat-stack/core/Billing") {}

export type SubscriptionChange = Omit<SubscriptionRecordValue, "account">;

export type BillingChangeValue = Data.TaggedEnum<{
  ApplySubscription: {
    readonly account: Option.Option<AccountIdValue>;
    readonly customer: string;
    readonly subscription: SubscriptionChange;
  };
  Ignore: { readonly type: string };
  LinkCustomer: {
    readonly account: AccountIdValue;
    readonly customer: string;
  };
}>;

export const BillingChange = Data.taggedEnum<BillingChangeValue>();

export type BillingOutcome = "Applied" | "Ignored" | "Stale" | "Unmatched";

export const applyBillingChange = Effect.fn("applyBillingChange")(
  function* applyBillingChange(change: BillingChangeValue) {
    const store = yield* BillingStore;
    const now = yield* Clock.currentTimeMillis;

    return yield* BillingChange.$match(change, {
      ApplySubscription: ({ account, customer, subscription }) =>
        Effect.gen(function* applySubscription() {
          const owner = Option.isSome(account)
            ? account
            : yield* store.accountOfCustomer(customer);

          if (Option.isNone(owner)) {
            yield* Effect.logWarning("subscription for an unknown customer", {
              customer,
              subscription: subscription.subscriptionId,
            });

            const unmatched: BillingOutcome = "Unmatched";

            return unmatched;
          }

          yield* store.linkCustomer(owner.value, customer, now);

          const applied = yield* store.applySubscription({
            ...subscription,
            account: owner.value,
          });

          const outcome: BillingOutcome = applied ? "Applied" : "Stale";

          return outcome;
        }),
      Ignore: () => Effect.succeed<BillingOutcome>("Ignored"),
      LinkCustomer: ({ account, customer }) =>
        store
          .linkCustomer(account, customer, now)
          .pipe(Effect.as<BillingOutcome>("Applied")),
    });
  }
);

export const entitlementOfAccount = Effect.fn("entitlementOfAccount")(
  function* entitlementOfAccount(account: AccountIdValue) {
    const store = yield* BillingStore;
    const subscriptions = yield* store.subscriptionsOf(account);

    return entitlementOf(subscriptions, yield* Clock.currentTimeMillis);
  }
);
