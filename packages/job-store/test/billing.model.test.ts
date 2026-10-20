// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test reads the checked-in Stripe webhook fixtures once before any Effect runs.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { billingChangeOf } from "@rat-stack/billing";
import { toRpc } from "@rat-stack/capability/rpc";
import {
  Account,
  AccountId,
  applyBillingChange,
  BillingStore,
  CurrentViewer,
  entitlementOf,
  FREE,
  JobStore,
  listJobs,
  ProEntitlement,
  Viewer,
} from "@rat-stack/core";
import type {
  AccountIdValue,
  EntitlementValue,
  JobQueryValue,
  JobValue,
  ViewerValue,
} from "@rat-stack/core";
import { Array, Effect, Layer, Schema } from "effect";
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

const PERIOD_END = 1_795_102_447_000;

const DURING_PERIOD = 1_793_000_000_000;

const ada = AccountId.make("user_ada");

const withBilling = <A, E>(
  body: Effect.Effect<A, E, BillingStore | JobStore | SqlExecutor>
) =>
  Effect.gen(function* provideBilling() {
    const base = yield* sqlJsJobStore;

    return yield* body.pipe(
      Effect.provide(billingStoreLayer.pipe(Layer.provideMerge(base)))
    );
  });

const addMember = (id: AccountIdValue) =>
  SqlExecutor.use((sql) =>
    sql.batch("addMember", [
      statement(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)`,
        [id, id, `${id}@example.com`]
      ),
    ])
  );

const sandbox = {
  livemode: false,
  prices: {
    Monthly: "price_1USIFA0ZnafJYNlYo9bbbD97",
    Quarterly: "price_sandbox_quarterly",
    Yearly: "price_sandbox_yearly",
  },
};

const deliver = (payload: string) =>
  billingChangeOf(sandbox, payload).pipe(Effect.flatMap(applyBillingChange));

const entitlementAt = (now: number) =>
  BillingStore.use((store) => store.subscriptionsOf(ada)).pipe(
    Effect.map((subscriptions) => entitlementOf(subscriptions, now))
  );

const permutations = <A>(items: readonly A[]): readonly (readonly A[])[] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
          (rest) => [item, ...rest]
        )
      );

const replayed = (order: readonly string[]) =>
  withBilling(
    Effect.gen(function* replay() {
      yield* addMember(ada);
      yield* Effect.forEach(order, deliver, { discard: true });

      return yield* entitlementAt(DURING_PERIOD);
    })
  );

const proUntilPeriodEnd = (renews: boolean): EntitlementValue =>
  ProEntitlement.make({ periodEnd: PERIOD_END, plan: "Monthly", renews });

describe("Stripe webhook replay", () => {
  it.effect(
    "ends on the latest event's entitlement in every delivery order of the recorded lifecycle",
    () =>
      Effect.gen(function* everyOrder() {
        const cases: readonly (readonly [number, EntitlementValue])[] = [
          [2, proUntilPeriodEnd(true)],
          [3, proUntilPeriodEnd(false)],
          [4, proUntilPeriodEnd(true)],
          [5, FREE],
        ];

        for (const [count, expected] of cases) {
          const orders = permutations(lifecycle.slice(0, count));

          const outcomes = yield* Effect.forEach(orders, replayed, {
            concurrency: 1,
          });

          expect(
            Array.dedupe(outcomes.map((outcome) => JSON.stringify(outcome)))
          ).toEqual([JSON.stringify(expected)]);
        }
      }),
    30_000
  );

  it.effect(
    "leaves the entitlement unchanged when every event is delivered twice",
    () =>
      Effect.gen(function* twice() {
        const once = yield* replayed(lifecycle.slice(0, 4));

        const doubled = yield* replayed([
          ...lifecycle.slice(0, 4),
          ...lifecycle.slice(0, 4).toReversed(),
        ]);

        expect(doubled).toEqual(once);
      })
  );

  it.effect(
    "lets Pro run to the period end after a cancel, then reverts to Free",
    () =>
      withBilling(
        Effect.gen(function* lapse() {
          yield* addMember(ada);
          yield* Effect.forEach(lifecycle.slice(0, 3), deliver, {
            discard: true,
          });

          expect(yield* entitlementAt(PERIOD_END - 1)).toEqual(
            proUntilPeriodEnd(false)
          );
          expect(yield* entitlementAt(PERIOD_END)).toEqual(FREE);
        })
      )
  );

  it.effect(
    "holds a subscription for an unlinked customer until the checkout link arrives",
    () =>
      withBilling(
        Effect.gen(function* unlinked() {
          yield* addMember(ada);

          const [checkout = "", created = ""] = lifecycle;

          const anonymous = created.replaceAll('"account_id":"user_ada"', "");

          const early = yield* deliver(anonymous);

          yield* deliver(checkout);

          const retried = yield* deliver(anonymous);

          expect([early, retried]).toEqual(["Unmatched", "Applied"]);
          expect(yield* entitlementAt(DURING_PERIOD)).toEqual(
            proUntilPeriodEnd(true)
          );
        })
      )
  );
});

const NOW = 1_761_000_000_000;

const DAY = 86_400_000;

const seed = (
  overrides: Partial<JobValue> & Pick<JobValue, "id" | "feed" | "source">
): JobValue => ({
  arrangement: "Remote",
  company: "Acme",
  firstSeenAt: NOW - DAY,
  lastSeenAt: NOW - DAY,
  location: "Remote - Canada",
  postedAt: NOW - DAY,
  region: "RemoteCanada",
  relevance: 50,
  role: "Director",
  salary: null,
  title: `Director ${overrides.id}`,
  url: `https://jobs.example/${overrides.id}`,
  ...overrides,
});

const board: readonly JobValue[] = [
  seed({
    feed: "greenhouse:acme",
    id: "gh-1",
    source: "Greenhouse",
  }),
  seed({ feed: "greenhouse:acme", id: "gh-2", source: "Greenhouse" }),
  seed({
    feed: "remotive:all",
    id: "rm-1",
    salary: "$240k",
    source: "Remotive",
    title: "Head of Platform",
  }),
  seed({
    feed: "jobicy:all",
    id: "jb-1",
    salary: "$200k",
    source: "Jobicy",
    title: "VP Engineering",
  }),
  seed({
    feed: "hn:hiring",
    id: "hn-1",
    location: "Vancouver, BC",
    region: "BritishColumbia",
    role: "EngineeringManager",
    source: "HackerNews",
    title: "Engineering Manager",
  }),
];

const everything: JobQueryValue = {
  limit: 100,
  maxAgeDays: 30,
  offset: 0,
  regions: [],
  roles: [],
  salaryFloor: null,
  salaryListed: false,
  search: "",
  seniorities: [],
  sort: "Newest",
};

const member = (id: string) =>
  Schema.decodeSync(Account)({ email: `${id}@example.com`, id, name: id });

const projection = toRpc([listJobs]);

const rowsFor = (viewer: ViewerValue, query: JobQueryValue) =>
  Effect.gen(function* rows() {
    const client = yield* RpcTest.makeClient(projection.group);
    const page = yield* client.listJobs(query);

    return page.jobs.map((job) => job.id);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      projection.layer.pipe(Layer.provide(Layer.succeed(CurrentViewer, viewer)))
    )
  );

describe("listJobs for Free and Pro viewers", () => {
  it.effect(
    "returns the same rows to anonymous, Free, and Pro viewers, and ignores a Free viewer's Pro filter",
    () =>
      withBilling(
        Effect.gen(function* sameRows() {
          const free = member("user_free");
          const pro = member("user_pro");

          yield* Effect.forEach([free.id, pro.id], addMember, {
            discard: true,
          });

          yield* JobStore.use((store) =>
            Effect.forEach(
              Object.values(Array.groupBy(board, (job) => job.feed)),
              (group) => store.replaceFeed(group[0].feed, group, NOW - DAY),
              { discard: true }
            )
          );

          yield* JobStore.use((store) =>
            Effect.forEach(
              ["gh-1", "gh-2", "rm-1"],
              (id) =>
                store.saveEnrichment(id, {
                  enrichedAt: NOW,
                  model: "test-model",
                  remotePolicy: "Remote",
                  reportsTo: null,
                  salary: {
                    currency: "USD",
                    max: id === "gh-1" ? 250_000 : 180_000,
                    min: 150_000,
                  },
                  seniority: id === "gh-1" ? "Director" : "Manager",
                  teamSize: null,
                }),
              { discard: true }
            )
          );

          yield* BillingStore.use((store) =>
            store.applySubscription({
              account: pro.id,
              cancelAtPeriodEnd: false,
              periodEnd: Number.MAX_SAFE_INTEGER,
              plan: "Yearly",
              status: "active",
              subscriptionId: "sub_pro",
              version: { created: 1, eventId: "evt_pro", rank: 0 },
            })
          );

          const salaried = { ...everything, salaryListed: true };

          const [
            anonymous,
            freeRows,
            proRows,
            publicFiltered,
            freeFiltered,
            proFiltered,
          ] = yield* Effect.all([
            rowsFor(Viewer.Anonymous(), everything),
            rowsFor(Viewer.Member({ account: free }), everything),
            rowsFor(Viewer.Member({ account: pro }), everything),
            rowsFor(Viewer.Anonymous(), salaried),
            rowsFor(Viewer.Member({ account: free }), salaried),
            rowsFor(Viewer.Member({ account: pro }), salaried),
          ]);

          expect(anonymous.toSorted()).toEqual(
            board.map((job) => job.id).toSorted()
          );
          expect(freeRows).toEqual(anonymous);
          expect(proRows).toEqual(anonymous);
          expect(publicFiltered).toEqual(anonymous);
          expect(freeFiltered).toEqual(anonymous);
          expect(proFiltered.toSorted()).toEqual(["gh-1", "gh-2", "jb-1"]);

          const enrichmentFilters: readonly JobQueryValue[] = [
            {
              ...everything,
              salaryFloor: { amount: 200_000, currency: "USD" },
            },
            { ...everything, seniorities: ["Director"] },
            {
              ...everything,
              salaryFloor: { amount: 200_000, currency: "USD" },
              salaryListed: true,
              seniorities: ["Director"],
            },
          ];

          for (const query of enrichmentFilters) {
            const [publicRows, memberRows, paidRows] = yield* Effect.all([
              rowsFor(Viewer.Anonymous(), query),
              rowsFor(Viewer.Member({ account: free }), query),
              rowsFor(Viewer.Member({ account: pro }), query),
            ]);

            expect(publicRows).toEqual(anonymous);
            expect(memberRows).toEqual(anonymous);
            expect(paidRows).toEqual(["gh-1"]);
          }

          const freeQueries: readonly (readonly [
            JobQueryValue,
            readonly string[],
          ])[] = [
            [{ ...everything, regions: ["BritishColumbia"] }, ["hn-1"]],
            [{ ...everything, roles: ["EngineeringManager"] }, ["hn-1"]],
            [{ ...everything, search: "gh-2" }, ["gh-2"]],
          ];

          for (const viewer of [
            Viewer.Anonymous(),
            Viewer.Member({ account: free }),
            Viewer.Member({ account: pro }),
          ]) {
            for (const [query, expected] of freeQueries) {
              expect(yield* rowsFor(viewer, query)).toEqual(expected);
            }
          }
        })
      )
  );
});
