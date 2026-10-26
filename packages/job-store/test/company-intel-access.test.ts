import { describe, expect, it } from "@effect/vitest";
import { toRpc } from "@rat-stack/capability/rpc";
import {
  Account,
  BillingStore,
  companyIntel,
  CurrentViewer,
  DAY_MILLIS,
  JobStore,
  PostingFeeds,
  runIngest,
  ShownTrend,
  SourceName,
  Viewer,
} from "@rat-stack/core";
import type {
  AccountIdValue,
  FeedRef,
  JobQueryValue,
  PostingValue,
  ViewerValue,
} from "@rat-stack/core";
import { Array, Effect, Exit, Layer, Option, Schema } from "effect";
import { RpcTest } from "effect/rpc";
import { TestClock } from "effect/testing";

import { billingStoreLayer, SqlExecutor, statement } from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const BOARD = "greenhouse:acme-cloud";

const REMOTIVE = "remotive:engineering";

const catalog: readonly FeedRef[] = [
  {
    company: Option.some("Acme Cloud"),
    key: BOARD,
    minIntervalMinutes: 1,
    source: "Greenhouse",
  },
  {
    company: Option.none(),
    key: REMOTIVE,
    minIntervalMinutes: 1,
    source: "Remotive",
  },
];

const posting = (
  externalId: string,
  title: string,
  company = "Acme Cloud"
): PostingValue => ({
  company,
  externalId,
  location: "Remote - Canada",
  postedAt: null,
  salary: null,
  title,
  url: `https://jobs.example/${externalId}`,
  workplace: "Remote",
});

const vp = posting("vp", "VP Engineering");

const director = posting("dir", "Director of Platform");

const manager = posting("em", "Engineering Manager, Billing");

const lookalike = posting("other", "VP Engineering", "Acme Cloudy");

const remotiveHead = posting("rm", "Head of Engineering");

const ingestAt = (
  day: number,
  board: readonly PostingValue[],
  remotive: readonly PostingValue[] = [remotiveHead]
) =>
  Effect.gen(function* ingestDay() {
    yield* TestClock.setTime(NOW + day * DAY_MILLIS);

    const listed = new Map([
      [BOARD, board],
      [REMOTIVE, remotive],
    ]);

    return yield* runIngest({ feedConcurrency: 1, feedsPerRun: 2 }).pipe(
      Effect.provideService(
        PostingFeeds,
        PostingFeeds.of({
          catalog,
          fetch: (feed) => Effect.succeed(listed.get(feed.key) ?? []),
        })
      )
    );
  });

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

const addMember = (id: AccountIdValue) =>
  SqlExecutor.use((sql) =>
    sql.batch("addMember", [
      statement(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)`,
        [id, id, `${id}@example.com`]
      ),
    ])
  );

const member = (id: string) =>
  Schema.decodeSync(Account)({ email: `${id}@example.com`, id, name: id });

const projection = toRpc([companyIntel]);

const intelFor = (viewer: ViewerValue, slug: string) =>
  Effect.gen(function* askForIntel() {
    const client = yield* RpcTest.makeClient(projection.group);

    return yield* client.companyIntel({ slug });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      projection.layer.pipe(Layer.provide(Layer.succeed(CurrentViewer, viewer)))
    ),
    Effect.exit
  );

const withStores = <A, E>(
  body: Effect.Effect<A, E, BillingStore | JobStore | SqlExecutor>
) =>
  Effect.gen(function* provideStores() {
    const base = yield* sqlJsJobStore;

    return yield* body.pipe(
      Effect.provide(billingStoreLayer.pipe(Layer.provideMerge(base)))
    );
  });

describe("the companyIntel capability", () => {
  it.effect(
    "gives a Pro member days open in the current stint, reposts from history, a trend and bands, without Remotive data or a look-alike company",
    () =>
      withStores(
        Effect.gen(function* proIntel() {
          yield* ingestAt(0, [vp, director, manager, lookalike]);
          yield* ingestAt(1, [vp, director, lookalike]);
          yield* ingestAt(2, [director, lookalike]);
          yield* ingestAt(10, [vp, director, lookalike]);
          yield* ingestAt(11, [vp, director, lookalike]);
          yield* ingestAt(12, [director, lookalike]);
          yield* ingestAt(20, [vp, director, lookalike]);
          yield* ingestAt(29, [vp, director, lookalike]);

          const store = yield* JobStore;

          const listed = yield* store.list(
            everything,
            NOW + 29 * DAY_MILLIS,
            SourceName.literals
          );

          const idOf = (title: string, company = "Acme Cloud") =>
            Option.getOrThrow(
              Array.findFirst(
                listed.jobs,
                (job) => job.title === title && job.company === company
              )
            ).id;

          yield* Effect.forEach(
            [
              [idOf("VP Engineering"), 300_000, 360_000],
              [idOf("Director of Platform"), 220_000, 260_000],
              [idOf("Head of Engineering"), 900_000, 999_000],
            ] as const,
            ([id, min, max]) =>
              store.saveEnrichment(id, {
                board: null,
                enrichedAt: NOW,
                model: "fixture",
                remotePolicy: null,
                reportsTo: null,
                salary: { currency: "USD", max, min },
                seniority: null,
                teamSize: null,
              }),
            { discard: true }
          );

          const pro = member("user_pro");

          yield* addMember(pro.id);
          yield* BillingStore.use((billing) =>
            billing.applySubscription({
              account: pro.id,
              cancelAtPeriodEnd: false,
              periodEnd: Number.MAX_SAFE_INTEGER,
              plan: "Monthly",
              status: "active",
              subscriptionId: "sub_pro",
              version: { created: 1, eventId: "evt_pro", rank: 0 },
            })
          );

          const intel = yield* intelFor(
            Viewer.Member({ account: pro }),
            "acme-cloud"
          );

          expect(intel).toStrictEqual(
            Exit.succeed({
              bands: [
                { currency: "USD", max: 310_000, min: 260_000, roles: 2 },
              ],
              roles: [
                {
                  daysOpen: 29,
                  id: idOf("Director of Platform"),
                  reposts: 0,
                  role: "Director",
                  title: "Director of Platform",
                },
                {
                  daysOpen: 9,
                  id: idOf("VP Engineering"),
                  reposts: 2,
                  role: "VicePresident",
                  title: "VP Engineering",
                },
              ],
              trackedSince: NOW,
              trend: ShownTrend.make({
                weeks: [
                  [3, 1],
                  [2, 2],
                  [1, 2],
                  [0, 2],
                ].map(([weeksAgo = 0, open = 0]) => ({
                  open,
                  weekEnding: NOW + (29 - 7 * weeksAgo) * DAY_MILLIS,
                })),
              }),
            })
          );
        })
      )
  );

  it.effect(
    "refuses a Free member with ProRequired and a signed-out viewer with Unauthorized",
    () =>
      withStores(
        Effect.gen(function* refused() {
          yield* ingestAt(0, [vp]);

          const free = member("user_free");

          yield* addMember(free.id);

          const [freeExit, anonymousExit] = yield* Effect.all([
            intelFor(Viewer.Member({ account: free }), "acme-cloud"),
            intelFor(Viewer.Anonymous(), "acme-cloud"),
          ]);

          expect(
            Exit.findErrorOption(freeExit).pipe(
              Option.map((error) => error._tag)
            )
          ).toStrictEqual(Option.some("ProRequired"));
          expect(
            Exit.findErrorOption(anonymousExit).pipe(
              Option.map((error) => error._tag)
            )
          ).toStrictEqual(Option.some("Unauthorized"));
        })
      )
  );
});
