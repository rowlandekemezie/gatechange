import {
  AccountId,
  BillingStore,
  Plan,
  SubscriptionStatus,
} from "@rat-stack/core";
import type { SubscriptionRecordValue } from "@rat-stack/core";
import { Array, Effect, Layer, Option, Schema } from "effect";

import { SqlExecutor, statement } from "./sql-executor.js";

const subscriptionColumns =
  "subscription_id, account_id, plan, status, period_end, cancel_at_period_end, event_created, event_rank, event_id";

const SubscriptionRow = Schema.Struct({
  account_id: AccountId,
  cancel_at_period_end: Schema.Literals([0, 1]),
  event_created: Schema.Int,
  event_id: Schema.NonEmptyString,
  event_rank: Schema.Int,
  period_end: Schema.Finite,
  plan: Plan,
  status: SubscriptionStatus,
  subscription_id: Schema.NonEmptyString,
});

const CustomerRow = Schema.Struct({ customer_id: Schema.NonEmptyString });

const AccountRow = Schema.Struct({ account_id: AccountId });

const recordOfRow = (
  row: typeof SubscriptionRow.Type
): SubscriptionRecordValue => ({
  account: row.account_id,
  cancelAtPeriodEnd: row.cancel_at_period_end === 1,
  periodEnd: row.period_end,
  plan: row.plan,
  status: row.status,
  subscriptionId: row.subscription_id,
  version: {
    created: row.event_created,
    eventId: row.event_id,
    rank: row.event_rank,
  },
});

export const makeBillingStore = Effect.gen(function* makeBillingStore() {
  const sql = yield* SqlExecutor;

  return BillingStore.of({
    accountOfCustomer: (customer) =>
      sql
        .all(
          "accountOfCustomer",
          statement(
            "SELECT account_id FROM billing_customers WHERE customer_id = ?",
            [customer]
          ),
          AccountRow
        )
        .pipe(
          Effect.map((rows) =>
            Option.map(Array.head(rows), (row) => row.account_id)
          )
        ),

    applySubscription: (record) =>
      sql
        .batch("applySubscription", [
          statement(
            `INSERT INTO subscriptions (${subscriptionColumns})
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM "user" WHERE id = ?)
ON CONFLICT (subscription_id) DO UPDATE SET
  account_id = excluded.account_id,
  plan = excluded.plan,
  status = excluded.status,
  period_end = excluded.period_end,
  cancel_at_period_end = excluded.cancel_at_period_end,
  event_created = excluded.event_created,
  event_rank = excluded.event_rank,
  event_id = excluded.event_id
WHERE (excluded.event_created, excluded.event_rank, excluded.event_id)
  > (subscriptions.event_created, subscriptions.event_rank, subscriptions.event_id)`,
            [
              record.subscriptionId,
              record.account,
              record.plan,
              record.status,
              record.periodEnd,
              record.cancelAtPeriodEnd ? 1 : 0,
              record.version.created,
              record.version.rank,
              record.version.eventId,
              record.account,
            ]
          ),
        ])
        .pipe(Effect.map(([applied]) => applied?.changes === 1)),

    customerOf: (account) =>
      sql
        .all(
          "customerOf",
          statement(
            "SELECT customer_id FROM billing_customers WHERE account_id = ?",
            [account]
          ),
          CustomerRow
        )
        .pipe(
          Effect.map((rows) =>
            Option.map(Array.head(rows), (row) => row.customer_id)
          )
        ),

    linkCustomer: (account, customer, at) =>
      sql
        .batch("linkCustomer", [
          statement(
            `INSERT INTO billing_customers (account_id, customer_id, linked_at)
SELECT id, ?, ? FROM "user" WHERE id = ?
ON CONFLICT DO NOTHING`,
            [customer, at, account]
          ),
        ])
        .pipe(Effect.asVoid),

    subscriptionsOf: (account) =>
      sql
        .all(
          "subscriptionsOf",
          statement(
            `SELECT ${subscriptionColumns} FROM subscriptions WHERE account_id = ?`,
            [account]
          ),
          SubscriptionRow
        )
        .pipe(Effect.map(Array.map(recordOfRow))),
  });
});

export const billingStoreLayer = Layer.effect(BillingStore, makeBillingStore);
