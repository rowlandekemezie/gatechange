import { Context } from "effect";
import type { Effect, Option } from "effect";

import type { AccountIdValue } from "./account.js";
import type { SubscriptionRecordValue } from "./entitlement.js";
import type { JobStoreUnavailable } from "./job-store-unavailable.js";

export class BillingStore extends Context.Service<
  BillingStore,
  {
    readonly accountOfCustomer: (
      customer: string
    ) => Effect.Effect<Option.Option<AccountIdValue>, JobStoreUnavailable>;
    readonly applySubscription: (
      record: SubscriptionRecordValue
    ) => Effect.Effect<boolean, JobStoreUnavailable>;
    readonly customerOf: (
      account: AccountIdValue
    ) => Effect.Effect<Option.Option<string>, JobStoreUnavailable>;
    readonly linkCustomer: (
      account: AccountIdValue,
      customer: string,
      at: number
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly subscriptionsOf: (
      account: AccountIdValue
    ) => Effect.Effect<readonly SubscriptionRecordValue[], JobStoreUnavailable>;
  }
>()("@rat-stack/core/BillingStore") {}
