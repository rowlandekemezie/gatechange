import { describe, expect, it } from "@effect/vitest";
import { toRpc } from "@rat-stack/capability/rpc";
import {
  agentSources,
  boardStats,
  CurrentViewer,
  getJob,
  JobStore,
  listJobs,
  PostingFeeds,
  ServedSources,
  Viewer,
} from "@rat-stack/core";
import type {
  JobQueryValue,
  JobValue,
  ViewerValue,
  BillingStore,
} from "@rat-stack/core";
import { Effect, Layer, Option } from "effect";
import { RpcTest } from "effect/rpc";

import { billingStoreLayer } from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const as =
  (viewer: ViewerValue) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, CurrentViewer, viewer);

const withStores = <A, E>(body: Effect.Effect<A, E, BillingStore | JobStore>) =>
  Effect.gen(function* provideStores() {
    const base = yield* sqlJsJobStore;

    return yield* body.pipe(
      Effect.provide(billingStoreLayer.pipe(Layer.provideMerge(base)))
    );
  });

const job = (source: JobValue["source"], id: string): JobValue => ({
  arrangement: "Remote",
  company: `${source} Co`,
  feed: `${source}:all`,
  firstSeenAt: NOW,
  id,
  lastSeenAt: NOW,
  location: "Remote - Canada",
  postedAt: NOW,
  region: "RemoteCanada",
  relevance: 50,
  role: "Director",
  salary: null,
  source,
  title: `Director of Engineering ${id}`,
  url: `https://jobs.example/${id}`,
});

const query: JobQueryValue = {
  limit: 50,
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

describe("agent sources", () => {
  it.effect(
    "an agent listing and lookup leave out every source whose terms forbid agent access",
    () =>
      withStores(
        Effect.gen(function* agentListing() {
          const store = yield* JobStore;

          const seeded = [
            job("Greenhouse", "g:1"),
            job("Jobicy", "j:1"),
            job("Remotive", "r:1"),
            job("Himalayas", "h:1"),
            job("HackerNews", "n:1"),
          ];

          for (const listing of seeded) {
            yield* store.replaceFeed(listing.feed, [listing], NOW);
          }

          const board = yield* listJobs.handler(query);

          const agents = yield* listJobs
            .handler(query)
            .pipe(Effect.provideService(ServedSources, agentSources()));

          const remotive = yield* getJob
            .handler({ id: "r:1" })
            .pipe(Effect.provideService(ServedSources, agentSources()));

          expect(board.jobs.map(({ id }) => id).toSorted()).toStrictEqual([
            "g:1",
            "h:1",
            "j:1",
            "n:1",
            "r:1",
          ]);
          expect(agents.jobs.map(({ id }) => id).toSorted()).toStrictEqual([
            "g:1",
            "j:1",
          ]);
          expect(agents.total).toBe(2);
          expect(Option.isNone(remotive)).toBe(true);
          expect(Option.isSome(yield* getJob.handler({ id: "r:1" }))).toBe(
            true
          );

          yield* store.recordFeedFailure("Greenhouse:removed", NOW, "removed");
          yield* store.recordFeedFailure("Remotive:all", NOW, "timeout");

          const catalog = seeded.map((row) => ({
            company: Option.some(row.company),
            key: row.feed,
            minIntervalMinutes: 60,
            source: row.source,
          }));

          const feeds = PostingFeeds.of({
            catalog,
            fetch: () => Effect.die("boardStats must not fetch listings"),
          });

          const agentStats = yield* boardStats
            .handler({})
            .pipe(
              Effect.provideService(ServedSources, agentSources()),
              Effect.provideService(PostingFeeds, feeds)
            );

          const boardWide = yield* boardStats
            .handler({})
            .pipe(Effect.provideService(PostingFeeds, feeds));

          expect(agentStats.activeJobs).toBe(agents.total);
          expect(agentStats.regions).toStrictEqual([
            { count: 2, region: "RemoteCanada" },
          ]);
          expect(agentStats.roles).toStrictEqual([
            { count: 2, role: "Director" },
          ]);

          const projection = toRpc([boardStats]);

          const rpcStats = yield* Effect.scoped(
            Effect.gen(function* callBoardStatsRpc() {
              const client = yield* RpcTest.makeClient(projection.group).pipe(
                Effect.provide(projection.layer),
                Effect.provideService(JobStore, store),
                Effect.provideService(PostingFeeds, feeds)
              );

              return yield* client.boardStats({});
            })
          );

          expect(rpcStats).toStrictEqual(boardWide);
          expect(boardWide.activeJobs).toBe(board.total);
          expect([
            agentStats.feedsTotal,
            agentStats.feedsFailing,
          ]).toStrictEqual([5, 1]);
          expect([boardWide.feedsTotal, boardWide.feedsFailing]).toStrictEqual([
            5, 1,
          ]);
          expect(
            (yield* store.feedStates).some(
              (state) => state.key === "Greenhouse:removed"
            )
          ).toBe(true);
        }).pipe(as(Viewer.Anonymous()))
      )
  );
});
