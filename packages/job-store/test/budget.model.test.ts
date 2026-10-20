import { describe, expect, it } from "@effect/vitest";
import {
  AccountId,
  AlertStore,
  BillingStore,
  DAY_MILLIS,
  DigestMailer,
  INSTANT_SENDS_PER_MEMBER_PER_DAY,
  JobStore,
  MAX_SAVED_SEARCHES,
  periodStartOf,
  runDigests,
  runInstantAlerts,
} from "@rat-stack/core";
import type {
  AccountIdValue,
  Digest,
  DigestPlan,
  JobValue,
  SearchFiltersValue,
} from "@rat-stack/core";
import { Array, Effect, Layer } from "effect";

import {
  alertStoreLayer,
  billingStoreLayer,
  SqlExecutor,
  statement,
} from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const HOUR = 3_600_000;

const MINUTE = 60_000;

const MONDAY = periodStartOf(1_761_000_000_000) + 7 * DAY_MILLIS;

const PLAN: DigestPlan = { dailySendLimit: 50, sendsPerRun: 25 };

const WEEKLY_MEMBERS = 200;

const SIMULATED_DAYS = 9;

const job = (id: string, firstSeenAt: number): JobValue => ({
  arrangement: "Remote",
  company: "Acme",
  feed: "jobicy:all",
  firstSeenAt,
  id,
  lastSeenAt: firstSeenAt,
  location: "Remote - Canada",
  postedAt: firstSeenAt,
  region: "RemoteCanada",
  relevance: 50,
  role: "Director",
  salary: null,
  source: "Jobicy",
  title: `Director ${id}`,
  url: `https://jobicy.example/${id}`,
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

const BROAD_SEARCH: SearchFiltersValue = {
  regions: ["RemoteCanada"],
  roles: ["Director"],
  search: "",
};

type Tick = "Ingest" | "Weekly" | "Instant";

const HOURLY_TICKS: readonly (readonly [number, Tick])[] = [
  [0, "Ingest"],
  [7, "Weekly"],
  [10, "Instant"],
  [20, "Ingest"],
  [30, "Instant"],
  [40, "Ingest"],
  [50, "Instant"],
];

const simulateWeek = (proMembers: number) => {
  const sent: Digest[] = [];
  const start = MONDAY - 2 * DAY_MILLIS;

  const week = Effect.gen(function* week() {
    const pros =
      proMembers === 0
        ? []
        : Array.makeBy(proMembers, (index) =>
            AccountId.make(`user_pro${index}`)
          );

    const weeklies = Array.makeBy(WEEKLY_MEMBERS, (index) =>
      AccountId.make(`user_weekly${index}`)
    );

    for (const id of [...pros, ...weeklies]) {
      yield* addMember(id);
      yield* AlertStore.use((store) =>
        store.saveSearch(
          id,
          BROAD_SEARCH,
          start - 30 * DAY_MILLIS,
          MAX_SAVED_SEARCHES
        )
      );
    }

    for (const id of pros) {
      yield* BillingStore.use((store) =>
        store.applySubscription({
          account: id,
          cancelAtPeriodEnd: false,
          periodEnd: start + 60 * DAY_MILLIS,
          plan: "Monthly",
          status: "active",
          subscriptionId: `sub_${id}`,
          version: { created: 1, eventId: `evt_${id}`, rank: 0 },
        })
      );
      yield* AlertStore.use((store) =>
        store.setInstantAlerts(id, true, start - 2 * DAY_MILLIS)
      );
    }

    const jobs: JobValue[] = [];

    for (let hour = 0; hour < SIMULATED_DAYS * 24; hour += 1) {
      for (const [minute, tick] of HOURLY_TICKS) {
        const at = start + hour * HOUR + minute * MINUTE;

        if (tick === "Ingest") {
          jobs.push(job(`job${at}`, at));
          yield* JobStore.use((store) =>
            store.replaceFeed("jobicy:all", jobs.slice(-60), at)
          );
        } else if (tick === "Instant") {
          yield* runInstantAlerts(PLAN, at);
        } else if (at >= MONDAY) {
          yield* runDigests(PLAN, at);
        }
      }
    }
  });

  return Effect.gen(function* run() {
    const base = yield* sqlJsJobStore;

    yield* week.pipe(
      Effect.provide(
        Layer.mergeAll(alertStoreLayer, billingStoreLayer).pipe(
          Layer.provideMerge(base)
        )
      ),
      Effect.provideService(
        DigestMailer,
        DigestMailer.of({
          send: (digest) =>
            Effect.sync(() => {
              sent.push(digest);
            }),
        })
      )
    );

    const weekly = sent.filter((digest) => digest.cadence === "Weekly");
    const instant = sent.filter((digest) => digest.cadence === "Instant");

    return {
      instantPerPro: Array.dedupe(instant.map((digest) => digest.account)).map(
        (account) =>
          instant.filter((digest) => digest.account === account).length
      ),
      weeklyDelivered: new Set(
        weekly.flatMap((digest) =>
          digest.account.startsWith("user_weekly") ? [digest.account] : []
        )
      ).size,
    };
  });
};

describe("daily email budget", () => {
  it.effect(
    "delivers all 200 weekly digests in a week however busy the Pro members' instant alerts are",
    () =>
      Effect.gen(function* crowdOut() {
        const outcomes = yield* Effect.forEach([0, 1, 3], simulateWeek);

        expect(outcomes.map((outcome) => outcome.weeklyDelivered)).toEqual([
          WEEKLY_MEMBERS,
          WEEKLY_MEMBERS,
          WEEKLY_MEMBERS,
        ]);
        expect(
          outcomes.map(({ instantPerPro }) => [
            instantPerPro.length,
            instantPerPro.every(
              (count) =>
                count >= SIMULATED_DAYS &&
                count <= SIMULATED_DAYS * INSTANT_SENDS_PER_MEMBER_PER_DAY
            ),
          ])
        ).toEqual([
          [0, true],
          [1, true],
          [3, true],
        ]);
      }),
    600_000
  );
});
