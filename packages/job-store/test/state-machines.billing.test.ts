// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test reads the checked-in Stripe webhook fixtures once before any Effect runs.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { billingChangeOf } from "@rat-stack/billing";
import { toRpc } from "@rat-stack/capability/rpc";
import {
  Account,
  applyBillingChange,
  Billing,
  BillingStore,
  CurrentViewer,
  entitlementOf,
  startCheckout,
  Viewer,
} from "@rat-stack/core";
import type { CheckoutRequest } from "@rat-stack/core";
import { Effect, Layer, Predicate, Schema } from "effect";
import { RpcTest } from "effect/rpc";

import { billingStoreLayer, SqlExecutor, statement } from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const Fixtures = Schema.fromJsonString(Schema.Array(Schema.Unknown));

const lifecycle: readonly string[] = Schema.decodeUnknownSync(Fixtures)(
  readFileSync(
    new URL("../../billing/test/fixtures/pro-lifecycle.json", import.meta.url),
    "utf-8"
  )
).map((event) => JSON.stringify(event));

const DURING_PERIOD = 1_793_000_000_000;

const ada = Schema.decodeSync(Account)({
  email: "user_ada@example.com",
  id: "user_ada",
  name: "Ada",
});

const sandbox = {
  livemode: false,
  prices: new Map([["price_1USIFA0ZnafJYNlYo9bbbD97", "Monthly"]]),
};

const withBilling = <A, E>(
  body: Effect.Effect<A, E, BillingStore | SqlExecutor>
) =>
  Effect.gen(function* provideBilling() {
    const base = yield* sqlJsJobStore;

    return yield* body.pipe(
      Effect.provide(billingStoreLayer.pipe(Layer.provideMerge(base)))
    );
  });

const addAda = SqlExecutor.use((sql) =>
  sql.batch("addMember", [
    statement(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)`,
      [ada.id, ada.name, ada.email]
    ),
  ])
);

const deliver = (payload: string) =>
  billingChangeOf(sandbox, payload).pipe(Effect.flatMap(applyBillingChange));

const renewsNow = BillingStore.use((store) =>
  store.subscriptionsOf(ada.id)
).pipe(
  Effect.map((subscriptions) => {
    const entitlement = entitlementOf(subscriptions, DURING_PERIOD);

    return Predicate.isTagged(entitlement, "Pro") ? entitlement.renews : null;
  })
);

const [, created = "", cancelled = "", resumed = ""] = lifecycle;

const resumedInTheSameSecond = (cancelId: string, resumeId: string) => {
  const cancel = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ created: Schema.Int }))
  )(cancelled);

  return {
    cancel: cancelled.replace(/"id":"evt_[^"]+"/u, `"id":"${cancelId}"`),
    resume: resumed
      .replace(/"id":"evt_[^"]+"/u, `"id":"${resumeId}"`)
      .replace(/"created":\d+,"data"/u, `"created":${cancel.created},"data"`),
  };
};

const checkoutWorld = () => {
  const checkouts: CheckoutRequest[] = [];

  const layer = Layer.succeed(
    Billing,
    Billing.of({
      checkout: (request) =>
        Effect.sync(() => {
          checkouts.push(request);

          return `https://checkout.stripe.test/${checkouts.length}`;
        }),
      createCustomer: () => Effect.succeed("cus_ada"),
      plans: [
        {
          amountCents: 900,
          interval: "month",
          intervalCount: 1,
          plan: "Monthly",
        },
      ],
      portal: () => Effect.succeed("https://billing.stripe.test/portal"),
    })
  );

  return { checkouts, layer };
};

const projection = toRpc([startCheckout]);

const pressUpgrade = (world: ReturnType<typeof checkoutWorld>) =>
  Effect.gen(function* upgrade() {
    const client = yield* RpcTest.makeClient(projection.group);

    return yield* client.startCheckout({ plan: "Monthly" }).pipe(Effect.result);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      projection.layer.pipe(
        Layer.provide(world.layer),
        Layer.provide(
          Layer.succeed(CurrentViewer, Viewer.Member({ account: ada }))
        )
      )
    )
  );

describe("server-billing-webhook model replay", () => {
  it.effect.fails(
    "AccountShowsLatestChange: a resume in the same second as the cancel leaves Pro renewing",
    () =>
      withBilling(
        Effect.gen(function* sameSecond() {
          yield* addAda;

          const events = resumedInTheSameSecond(
            "evt_zz_cancel",
            "evt_aa_resume"
          );

          yield* Effect.forEach(
            [created, events.cancel, events.resume],
            deliver,
            {
              discard: true,
            }
          );

          expect(yield* renewsNow).toBe(true);
        })
      )
  );

  it.effect(
    "AccountShowsLatestChange: a resume in the same second whose id sorts later leaves Pro renewing",
    () =>
      withBilling(
        Effect.gen(function* sameSecondOrderedIds() {
          yield* addAda;

          const events = resumedInTheSameSecond(
            "evt_aa_cancel",
            "evt_zz_resume"
          );

          yield* Effect.forEach(
            [events.resume, created, events.cancel],
            deliver,
            {
              discard: true,
            }
          );

          expect(yield* renewsNow).toBe(true);
        })
      )
  );

  it.effect(
    "NoRollbackToEarlierSecond: a replayed older cancel never overrides a later resume",
    () =>
      withBilling(
        Effect.gen(function* lateReplay() {
          yield* addAda;

          yield* Effect.forEach(
            [created, cancelled, resumed, cancelled, created],
            deliver,
            { discard: true }
          );

          expect(yield* renewsNow).toBe(true);
        })
      )
  );
});

describe("server-checkout model replay", () => {
  it.effect.fails(
    "ChargedForOneProAtMost: a second Upgrade after paying, before Stripe reports it, opens no second checkout",
    () =>
      withBilling(
        Effect.gen(function* secondTab() {
          yield* addAda;
          const world = checkoutWorld();

          const first = yield* pressUpgrade(world);
          const second = yield* pressUpgrade(world);

          expect(first._tag).toBe("Success");
          expect(second._tag).toBe("Failure");
          expect(world.checkouts).toHaveLength(1);
        })
      )
  );

  it.effect(
    "ProMemberCannotStartCheckout: once Stripe reports the payment, Upgrade is refused",
    () =>
      withBilling(
        Effect.gen(function* afterWebhook() {
          yield* addAda;
          const world = checkoutWorld();

          expect((yield* pressUpgrade(world))._tag).toBe("Success");
          yield* deliver(created);

          const again = yield* pressUpgrade(world);

          expect(again._tag).toBe("Failure");
          expect(world.checkouts).toHaveLength(1);
        })
      )
  );
});
