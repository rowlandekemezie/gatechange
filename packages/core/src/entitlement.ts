import { Array, Order, Predicate, Schema } from "effect";

import { AccountId } from "./account.js";
import { EpochMillis, SourceName } from "./job.js";
import type { JobQueryValue, SourceNameValue } from "./job.js";
import { SourceTerms } from "./source-terms.js";
import type { SourceTermsValue } from "./source-terms.js";

export const Plan = Schema.Literals(["Monthly", "Quarterly", "Yearly"]);

export type PlanValue = typeof Plan.Type;

export const plans: readonly PlanValue[] = Plan.literals;

export interface PlanPrice {
  readonly amountCents: number;
  readonly interval: "month" | "year";
  readonly intervalCount: number;
}

export const PLAN_PRICES: Readonly<Record<PlanValue, PlanPrice>> = {
  Monthly: { amountCents: 1900, interval: "month", intervalCount: 1 },
  Quarterly: { amountCents: 4900, interval: "month", intervalCount: 3 },
  Yearly: { amountCents: 14_900, interval: "year", intervalCount: 1 },
};

export const FreeEntitlement = Schema.TaggedStruct("Free", {});

export const ProEntitlement = Schema.TaggedStruct("Pro", {
  periodEnd: EpochMillis,
  plan: Plan,
  renews: Schema.Boolean,
});

export const Entitlement = Schema.Union([FreeEntitlement, ProEntitlement]);

export type EntitlementValue = typeof Entitlement.Type;

export const SubscriptionStatus = Schema.Literals([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);

export type SubscriptionStatusValue = typeof SubscriptionStatus.Type;

export const GRANTING_STATUSES: readonly SubscriptionStatusValue[] = [
  "trialing",
  "active",
  "past_due",
];

export const EventVersion = Schema.Struct({
  created: Schema.Int,
  eventId: Schema.NonEmptyString,
  rank: Schema.Int,
});

export type EventVersionValue = typeof EventVersion.Type;

export const versionOrder: Order.Order<EventVersionValue> = Order.combineAll([
  Order.mapInput(Order.Number, (version: EventVersionValue) => version.created),
  Order.mapInput(Order.Number, (version: EventVersionValue) => version.rank),
  Order.mapInput(Order.String, (version: EventVersionValue) => version.eventId),
]);

export const SubscriptionRecord = Schema.Struct({
  account: AccountId,
  cancelAtPeriodEnd: Schema.Boolean,
  periodEnd: EpochMillis,
  plan: Plan,
  status: SubscriptionStatus,
  subscriptionId: Schema.NonEmptyString,
  version: EventVersion,
});

export type SubscriptionRecordValue = typeof SubscriptionRecord.Type;

export const FREE: EntitlementValue = FreeEntitlement.make({});

const grants = (record: SubscriptionRecordValue, now: number) =>
  GRANTING_STATUSES.includes(record.status) && record.periodEnd > now;

const byPeriodEnd = Order.mapInput(
  Order.Number,
  (record: SubscriptionRecordValue) => record.periodEnd
);

export const entitlementOf = (
  subscriptions: readonly SubscriptionRecordValue[],
  now: number
): EntitlementValue => {
  const granting = subscriptions.filter((record) => grants(record, now));

  if (!Array.isReadonlyArrayNonEmpty(granting)) {
    return FREE;
  }

  const latest = Array.max(granting, byPeriodEnd);

  return ProEntitlement.make({
    periodEnd: latest.periodEnd,
    plan: latest.plan,
    renews: granting.some((record) => !record.cancelAtPeriodEnd),
  });
};

export const isPro = (entitlement: EntitlementValue) =>
  Predicate.isTagged(entitlement, "Pro");

export const paidFeaturesAllowed = (
  source: SourceNameValue,
  terms: Readonly<Record<SourceNameValue, SourceTermsValue>> = SourceTerms
) => !Predicate.isTagged(terms[source].paidFeatures, "Forbidden");

export const paidFeatureSources = (
  terms: Readonly<Record<SourceNameValue, SourceTermsValue>> = SourceTerms
): readonly SourceNameValue[] =>
  SourceName.literals.filter((source) => paidFeaturesAllowed(source, terms));

export const usesProFilters = (query: JobQueryValue) => query.salaryListed;

export const proFiltersCleared = (query: JobQueryValue): JobQueryValue => ({
  ...query,
  salaryListed: false,
});

export const Membership = Schema.Struct({
  entitlement: Entitlement,
  instantAlerts: Schema.Boolean,
});

export type MembershipValue = typeof Membership.Type;
