import { describe, expect, it } from "@effect/vitest";
import { toRpc } from "@rat-stack/capability/rpc";
import { Effect, Layer, Option, Schema } from "effect";
import { RpcTest } from "effect/rpc";

import {
  Account,
  AlertStore,
  Billing,
  BillingStore,
  CurrentViewer,
  entitlementOf,
  FREE,
  membership,
  openBillingPortal,
  ProEntitlement,
  setInstantAlerts,
  startCheckout,
  Viewer,
} from "../src/index.js";
import type {
  AccountIdValue,
  CheckoutRequest,
  SubscriptionRecordValue,
  SubscriptionStatusValue,
  ViewerValue,
} from "../src/index.js";

const ada = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

const subscription = (
  overrides: Partial<SubscriptionRecordValue> = {}
): SubscriptionRecordValue => ({
  account: ada.id,
  cancelAtPeriodEnd: false,
  periodEnd: 2000,
  plan: "Monthly",
  status: "active",
  subscriptionId: "sub_1",
  version: { created: 1, eventId: "evt_1", rank: 0 },
  ...overrides,
});

interface World {
  readonly checkouts: CheckoutRequest[];
  readonly created: string[];
  readonly customers: Map<AccountIdValue, string>;
  readonly instant: Set<AccountIdValue>;
  readonly subscriptions: SubscriptionRecordValue[];
}

const emptyWorld = (): World => ({
  checkouts: [],
  created: [],
  customers: new Map(),
  instant: new Set(),
  subscriptions: [],
});

const unused = () => Effect.die("unused");

const layerOf = (world: World) =>
  Layer.mergeAll(
    Layer.succeed(
      BillingStore,
      BillingStore.of({
        accountOfCustomer: unused,
        applySubscription: unused,
        customerOf: (account) =>
          Effect.sync(() => Option.fromNullishOr(world.customers.get(account))),
        linkCustomer: (account, customer) =>
          Effect.sync(() => {
            if (!world.customers.has(account)) {
              world.customers.set(account, customer);
            }
          }),
        subscriptionsOf: (account) =>
          Effect.sync(() =>
            world.subscriptions.filter((row) => row.account === account)
          ),
      })
    ),
    Layer.succeed(
      Billing,
      Billing.of({
        checkout: (request) =>
          Effect.sync(() => {
            world.checkouts.push(request);

            return "https://checkout.stripe.test/session";
          }),
        createCustomer: () =>
          Effect.gen(function* createCustomer() {
            yield* Effect.yieldNow;

            const customer = `cus_${world.created.length + 1}`;

            world.created.push(customer);

            return customer;
          }),
        portal: (customer) =>
          Effect.succeed(`https://billing.stripe.test/${customer}`),
      })
    ),
    Layer.succeed(
      AlertStore,
      AlertStore.of({
        claimDigest: unused,
        deleteSearch: unused,
        dueRecipients: unused,
        instantAlertsOf: (account) =>
          Effect.sync(() => world.instant.has(account)),
        jobsSeenSince: unused,
        markSent: unused,
        releaseDigest: unused,
        saveSearch: unused,
        searchesOf: unused,
        sendsSince: unused,
        setInstantAlerts: (account, enabled) =>
          Effect.sync(() => {
            if (enabled) {
              world.instant.add(account);
            } else {
              world.instant.delete(account);
            }
          }),
        unsubscribe: unused,
      })
    )
  );

const projection = toRpc([
  membership,
  startCheckout,
  openBillingPortal,
  setInstantAlerts,
]);

const clientAs = (viewer: ViewerValue, world: World) =>
  RpcTest.makeClient(projection.group).pipe(
    Effect.provide(
      projection.layer.pipe(
        Layer.provide(layerOf(world)),
        Layer.provide(Layer.succeed(CurrentViewer, viewer))
      )
    )
  );

const member = Viewer.Member({ account: ada });

describe("entitlementOf", () => {
  it("grants Pro while a paying subscription's period runs, then Free", () => {
    expect(entitlementOf([subscription()], 1999)).toEqual(
      ProEntitlement.make({ periodEnd: 2000, plan: "Monthly", renews: true })
    );
    expect(entitlementOf([subscription()], 2000)).toEqual(FREE);
  });

  it("never grants Pro for an unpaid, incomplete, or canceled subscription", () => {
    const lapsed: readonly SubscriptionStatusValue[] = [
      "incomplete",
      "incomplete_expired",
      "canceled",
      "unpaid",
      "paused",
    ];

    expect(
      lapsed.map((status) => entitlementOf([subscription({ status })], 0))
    ).toEqual(lapsed.map(() => FREE));
  });

  it("takes the latest period end across subscriptions and renews if any does", () => {
    expect(
      entitlementOf(
        [
          subscription({
            cancelAtPeriodEnd: true,
            periodEnd: 5000,
            plan: "Yearly",
          }),
          subscription({ periodEnd: 3000, subscriptionId: "sub_2" }),
          subscription({
            periodEnd: 9000,
            status: "canceled",
            subscriptionId: "sub_3",
          }),
        ],
        1000
      )
    ).toEqual(
      ProEntitlement.make({ periodEnd: 5000, plan: "Yearly", renews: true })
    );
  });
});

describe("billing capabilities", () => {
  it.effect("refuses every billing capability to an anonymous viewer", () =>
    Effect.gen(function* anonymous() {
      const world = emptyWorld();
      const client = yield* clientAs(Viewer.Anonymous(), world);

      const failures = yield* Effect.all([
        Effect.flip(client.membership({})),
        Effect.flip(client.startCheckout({ plan: "Monthly" })),
        Effect.flip(client.openBillingPortal({})),
        Effect.flip(client.setInstantAlerts({ enabled: true })),
      ]);

      expect(failures.map((failure) => failure._tag)).toEqual([
        "Unauthorized",
        "Unauthorized",
        "Unauthorized",
        "Unauthorized",
      ]);
      expect(world.checkouts).toEqual([]);
    })
  );

  it.effect(
    "starts a checkout for a Free member with their saved Stripe customer",
    () =>
      Effect.gen(function* checkout() {
        const world = emptyWorld();

        world.customers.set(ada.id, "cus_ada");

        const client = yield* clientAs(member, world);
        const link = yield* client.startCheckout({ plan: "Quarterly" });

        expect(link.url).toBe("https://checkout.stripe.test/session");
        expect(world.checkouts).toEqual([
          { account: ada, customer: "cus_ada", plan: "Quarterly" },
        ]);
        expect(world.created).toEqual([]);
      })
  );

  it.effect(
    "creates and links a Stripe customer before a member's first checkout, then reuses it",
    () =>
      Effect.gen(function* firstCheckout() {
        const world = emptyWorld();
        const client = yield* clientAs(member, world);

        yield* client.startCheckout({ plan: "Monthly" });
        yield* client.startCheckout({ plan: "Yearly" });

        expect(world.created).toEqual(["cus_1"]);
        expect(world.customers.get(ada.id)).toBe("cus_1");
        expect(world.checkouts.map((request) => request.customer)).toEqual([
          "cus_1",
          "cus_1",
        ]);
      })
  );

  it.effect(
    "sends two concurrent first checkouts to the one customer that won the link",
    () =>
      Effect.gen(function* doubleCheckout() {
        const world = emptyWorld();
        const client = yield* clientAs(member, world);

        yield* Effect.all(
          [
            client.startCheckout({ plan: "Monthly" }),
            client.startCheckout({ plan: "Monthly" }),
          ],
          { concurrency: "unbounded" }
        );

        const linked = world.customers.get(ada.id);

        expect(world.created).toHaveLength(2);
        expect(world.checkouts.map((request) => request.customer)).toEqual([
          linked,
          linked,
        ]);
      })
  );

  it.effect(
    "sends a Pro member to the portal instead of a second checkout",
    () =>
      Effect.gen(function* alreadyPro() {
        const world = emptyWorld();

        world.subscriptions.push(
          subscription({ periodEnd: Number.MAX_SAFE_INTEGER })
        );
        world.customers.set(ada.id, "cus_ada");

        const client = yield* clientAs(member, world);

        const refused = yield* Effect.flip(
          client.startCheckout({ plan: "Monthly" })
        );

        const portal = yield* client.openBillingPortal({});

        expect(refused._tag).toBe("AlreadyPro");
        expect(portal.url).toBe("https://billing.stripe.test/cus_ada");
        expect(world.checkouts).toEqual([]);
      })
  );

  it.effect("has no portal for a member who never paid", () =>
    Effect.gen(function* noPortal() {
      const client = yield* clientAs(member, emptyWorld());
      const refused = yield* Effect.flip(client.openBillingPortal({}));

      expect(refused._tag).toBe("NoBillingAccount");
    })
  );

  it.effect(
    "turns instant alerts on only for Pro, and lets anyone turn them off",
    () =>
      Effect.gen(function* instant() {
        const world = emptyWorld();

        world.instant.add(ada.id);

        const client = yield* clientAs(member, world);

        const refused = yield* Effect.flip(
          client.setInstantAlerts({ enabled: true })
        );

        const off = yield* client.setInstantAlerts({ enabled: false });

        world.subscriptions.push(
          subscription({ periodEnd: Number.MAX_SAFE_INTEGER })
        );

        const on = yield* client.setInstantAlerts({ enabled: true });

        expect(refused._tag).toBe("ProRequired");
        expect(off).toEqual({ entitlement: FREE, instantAlerts: false });
        expect(on.instantAlerts).toBe(true);
        expect(on.entitlement._tag).toBe("Pro");
      })
  );
});
