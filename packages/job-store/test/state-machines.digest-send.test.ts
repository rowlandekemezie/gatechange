import { describe, expect, it } from "@effect/vitest";
import {
  AccountId,
  AlertStore,
  DAY_MILLIS,
  DigestMailer,
  JobStore,
  MAX_SAVED_SEARCHES,
  periodStartOf,
  runDigests,
} from "@rat-stack/core";
import type {
  AccountIdValue,
  Digest,
  DigestPlan,
  JobValue,
  SearchFiltersValue,
} from "@rat-stack/core";
import { Effect, Layer } from "effect";

import { alertStoreLayer, SqlExecutor, statement } from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const MONDAY = periodStartOf(1_760_000_000_000);

const NOW = MONDAY + 2 * DAY_MILLIS;

const PLAN: DigestPlan = { dailySendLimit: 1000, sendsPerRun: 1000 };

const ada = AccountId.make("user_ada");

const bob = AccountId.make("user_bob");

const everywhere: SearchFiltersValue = {
  regions: ["RemoteCanada", "RemoteNorthAmerica", "RemoteGlobal"],
  roles: ["EngineeringManager", "Director"],
  search: "",
};

const listing: JobValue = {
  arrangement: "Remote",
  company: "Acme",
  feed: "jobicy:all",
  firstSeenAt: NOW - DAY_MILLIS,
  id: "gh:1",
  lastSeenAt: NOW - DAY_MILLIS,
  location: "Remote - Canada",
  postedAt: NOW - DAY_MILLIS,
  region: "RemoteCanada",
  relevance: 50,
  role: "EngineeringManager",
  salary: null,
  source: "Jobicy",
  title: "Engineering Manager",
  url: "https://jobs.example/1",
};

const outbox = () => {
  const sent: Digest[] = [];

  const layer = Layer.succeed(
    DigestMailer,
    DigestMailer.of({
      send: (digest) =>
        Effect.sync(() => {
          sent.push(digest);
        }),
    })
  );

  return { layer, sent };
};

const subscribed = (members: readonly AccountIdValue[]) =>
  Effect.gen(function* subscribedMembers() {
    const sql = yield* SqlExecutor;
    const store = yield* AlertStore;

    for (const id of members) {
      yield* sql.batch("addMember", [
        statement(
          `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`,
          [id, id, `${id}@example.com`, NOW, NOW]
        ),
      ]);
      yield* store.saveSearch(
        id,
        everywhere,
        NOW - 3 * DAY_MILLIS,
        MAX_SAVED_SEARCHES
      );
    }

    yield* JobStore.use((jobs) =>
      jobs.replaceFeed(listing.feed, [listing], NOW - DAY_MILLIS)
    );
  });

const withStores = <A, E>(
  body: Effect.Effect<A, E, AlertStore | JobStore | SqlExecutor>
) =>
  Effect.gen(function* provideStores() {
    const base = yield* sqlJsJobStore;

    return yield* body.pipe(
      Effect.provide(alertStoreLayer.pipe(Layer.provideMerge(base)))
    );
  });

const unsubscribingBeforeClaim = (member: AccountIdValue) =>
  Layer.effect(
    AlertStore,
    Effect.gen(function* interleaved() {
      const real = yield* AlertStore;

      return AlertStore.of({
        ...real,
        claimDigest: (cadence, account, periodStart, now, dailyLimit) =>
          (account === member
            ? real.unsubscribe(member, now)
            : Effect.void
          ).pipe(
            Effect.andThen(
              real.claimDigest(cadence, account, periodStart, now, dailyLimit)
            )
          ),
      });
    })
  );

describe("server-digest-send model replay", () => {
  it.effect(
    "NoSendReservedAfterUnsubscribe: an unsubscribe that lands after the recheck stops the digest",
    () =>
      withStores(
        Effect.gen(function* unsubscribeMidSend() {
          yield* subscribed([ada]);
          const mail = outbox();

          yield* runDigests(PLAN, NOW).pipe(
            Effect.provide(
              Layer.merge(mail.layer, unsubscribingBeforeClaim(ada))
            )
          );

          expect(mail.sent).toEqual([]);
        })
      )
  );

  it.effect(
    "NoSendReservedAfterUnsubscribe: an unsubscribe before the run stops the digest",
    () =>
      withStores(
        Effect.gen(function* unsubscribedFirst() {
          yield* subscribed([ada]);
          yield* AlertStore.use((store) => store.unsubscribe(ada, NOW));
          const mail = outbox();

          yield* runDigests(PLAN, NOW).pipe(Effect.provide(mail.layer));

          expect(mail.sent).toEqual([]);
        })
      )
  );

  it.effect(
    "OneDigestPerPeriod: two overlapping runs mail each member once",
    () =>
      withStores(
        Effect.gen(function* overlappingRuns() {
          yield* subscribed([ada, bob]);
          const mail = outbox();

          yield* Effect.all(
            [
              runDigests(PLAN, NOW).pipe(Effect.provide(mail.layer)),
              runDigests(PLAN, NOW + 1).pipe(Effect.provide(mail.layer)),
            ],
            { concurrency: 2 }
          );

          expect(mail.sent.map((digest) => digest.account).toSorted()).toEqual([
            ada,
            bob,
          ]);
        })
      )
  );

  it.effect(
    "DailyCapHolds: two overlapping runs stay inside a one-send daily budget",
    () =>
      withStores(
        Effect.gen(function* cappedRuns() {
          yield* subscribed([ada, bob]);
          const mail = outbox();
          const plan: DigestPlan = { dailySendLimit: 1, sendsPerRun: 10 };

          yield* Effect.all(
            [
              runDigests(plan, NOW).pipe(Effect.provide(mail.layer)),
              runDigests(plan, NOW + 1).pipe(Effect.provide(mail.layer)),
            ],
            { concurrency: 2 }
          );

          expect(mail.sent).toHaveLength(1);
        })
      )
  );
});
