// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test reads the checked-in webhook fixtures once before any Effect runs.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { BillingStore, versionOrder } from "@rat-stack/core";
import type { AccountIdValue, SubscriptionRecordValue } from "@rat-stack/core";
import { Effect, Option, Redacted, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  signatureHeader,
  signPayload,
  stripeWebhookResponse,
} from "../src/index.js";
import type { StripeEndpoint } from "../src/index.js";

const Fixtures = Schema.fromJsonString(Schema.Array(Schema.Unknown));

const [, created = ""] = Schema.decodeUnknownSync(Fixtures)(
  readFileSync(new URL("fixtures/pro-lifecycle.json", import.meta.url), "utf-8")
).map((event) => JSON.stringify(event));

const secret = Redacted.make("whsec_test_route_secret");

const sandbox: StripeEndpoint = {
  livemode: false,
  prices: {
    Monthly: "price_1USIFA0ZnafJYNlYo9bbbD97",
    Quarterly: "price_sandbox_quarterly",
    Yearly: "price_sandbox_yearly",
  },
  secret,
};

const makeStore = () => {
  const writes: string[] = [];
  const customers = new Map<AccountIdValue, string>();
  const rows = new Map<string, SubscriptionRecordValue>();

  const store = BillingStore.of({
    accountOfCustomer: (customer) =>
      Effect.sync(() =>
        Option.fromNullishOr(
          [...customers.entries()].find(([, id]) => id === customer)?.[0]
        )
      ),
    applySubscription: (record) =>
      Effect.sync(() => {
        const current = rows.get(record.subscriptionId);

        if (
          current !== undefined &&
          versionOrder(record.version, current.version) !== 1
        ) {
          return false;
        }

        rows.set(record.subscriptionId, record);
        writes.push(record.version.eventId);

        return true;
      }),
    customerOf: (account) =>
      Effect.sync(() => Option.fromNullishOr(customers.get(account))),
    linkCustomer: (account, customer) =>
      Effect.sync(() => {
        if (!customers.has(account)) {
          customers.set(account, customer);
        }
      }),
    subscriptionsOf: (account) =>
      Effect.sync(() =>
        [...rows.values()].filter((row) => row.account === account)
      ),
  });

  return { rows, store, writes };
};

const post = (
  store: BillingStore["Service"],
  payload: string,
  headers: Record<string, string>,
  method = "POST",
  endpoint: Option.Option<StripeEndpoint> = Option.some(sandbox)
) =>
  Effect.gen(function* posted() {
    const request = HttpServerRequest.fromWeb(
      new Request(
        "https://jobs.example/webhooks/stripe",
        method === "POST"
          ? { body: payload, headers, method }
          : { headers, method }
      )
    );

    const response = HttpServerResponse.toWeb(
      yield* stripeWebhookResponse(endpoint, request).pipe(
        Effect.provideService(BillingStore, store)
      )
    );

    return {
      body: yield* Effect.promise(
        // @effect-diagnostics-next-line asyncFunction:off -- The Web Response body is Promise-based.
        async () => await response.text()
      ),
      status: response.status,
    };
  });

const signedHeaders = (payload: string, at: number) =>
  signPayload(secret, Math.floor(at / 1000), payload).pipe(
    Effect.map((signature) => ({
      "stripe-signature": signatureHeader(Math.floor(at / 1000), signature),
    }))
  );

describe("Stripe webhook endpoint", () => {
  it.effect("rejects a bad signature with 400 and writes nothing", () =>
    Effect.gen(function* badSignature() {
      const { rows, store, writes } = makeStore();

      const forged = yield* post(store, created, {
        "stripe-signature": "t=0,v1=deadbeef",
      });

      expect(forged).toEqual({ body: "invalid signature", status: 400 });
      expect([writes, rows.size]).toEqual([[], 0]);
    })
  );

  it.effect(
    "applies a signed delivery once and answers a replay without a second write",
    () =>
      Effect.gen(function* replay() {
        const { store, writes } = makeStore();
        const headers = yield* signedHeaders(created, 0);

        const first = yield* post(store, created, headers);
        const again = yield* post(store, created, headers);

        expect([first, again]).toEqual([
          { body: "Applied", status: 200 },
          { body: "Stale", status: 200 },
        ]);
        expect(writes).toEqual(["evt_1USIZj0ZnafJYNlYFqQEBJXC"]);
      })
  );

  it.effect(
    "answers a test-mode delivery to the live endpoint without writing",
    () =>
      Effect.gen(function* testModeOnLive() {
        const { rows, store, writes } = makeStore();
        const headers = yield* signedHeaders(created, 0);

        const live = Option.some({ ...sandbox, livemode: true });

        expect(yield* post(store, created, headers, "POST", live)).toEqual({
          body: "Ignored",
          status: 200,
        });
        expect([writes, rows.size]).toEqual([[], 0]);
      })
  );

  it.effect(
    "asks Stripe to retry a subscription it cannot tie to a member yet",
    () =>
      Effect.gen(function* unmatched() {
        const { store } = makeStore();

        const orphan = created.replaceAll('"account_id":"user_ada"', "");

        expect(
          yield* post(store, orphan, yield* signedHeaders(orphan, 0))
        ).toEqual({ body: "Unmatched", status: 409 });
      })
  );

  it.effect(
    "refuses non-POST requests and answers 503 while billing is off",
    () =>
      Effect.gen(function* refusals() {
        const { store } = makeStore();
        const headers = yield* signedHeaders(created, 0);

        expect(yield* post(store, created, headers, "GET")).toEqual({
          body: "method not allowed",
          status: 405,
        });
        expect(
          yield* post(store, created, headers, "POST", Option.none())
        ).toEqual({ body: "billing is off", status: 503 });
      })
  );
});
