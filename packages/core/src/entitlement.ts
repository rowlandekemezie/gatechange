import { Array, Order, Predicate, Schema } from "effect";

import { AccountId } from "./account.js";
import { EpochMillis, SourceName } from "./job.js";
import type { JobQueryValue, SourceNameValue } from "./job.js";
import { SourceTerms } from "./source-terms.js";
import type { SourceTermsValue } from "./source-terms.js";

export const Plan = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Za-z0-9]{0,31}$/u)
);

export type PlanValue = typeof Plan.Type;

export const BillingInterval = Schema.Literals([
  "day",
  "week",
  "month",
  "year",
]);

export type BillingIntervalValue = typeof BillingInterval.Type;

export const PlanOffer = Schema.Struct({
  amountCents: Schema.Int.check(Schema.isGreaterThan(0)),
  interval: BillingInterval,
  intervalCount: Schema.Int.check(Schema.isGreaterThan(0)),
  plan: Plan,
});

export type PlanOfferValue = typeof PlanOffer.Type;

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

export const usesProFilters = (query: JobQueryValue) =>
  query.salaryListed ||
  query.salaryFloor !== null ||
  query.seniorities.length > 0;

export const proFiltersCleared = (query: JobQueryValue): JobQueryValue => ({
  ...query,
  salaryFloor: null,
  salaryListed: false,
  seniorities: [],
});

export const Membership = Schema.Struct({
  entitlement: Entitlement,
  instantAlerts: Schema.Boolean,
});

export type MembershipValue = typeof Membership.Type;
