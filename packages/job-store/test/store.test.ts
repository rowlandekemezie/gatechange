import { describe, expect, it } from "@effect/vitest";
import { Array, Effect, Option, pipe } from "effect";
import { DAY_MILLIS, JobStore } from "@rat-stack/core";
import type { JobQueryValue, JobValue } from "@rat-stack/core";

import { sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const job = (overrides: Partial<JobValue> & Pick<JobValue, "id" | "feed">): JobValue => ({
  arrangement: "Remote",
  company: "Acme",
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  location: "Remote - Canada",
  postedAt: NOW,
  region: "RemoteCanada",
  relevance: 50,
  role: "EngineeringManager",
  salary: null,
  source: "Greenhouse",
  title: "Engineering Manager",
  url: "https://jobs.example/1",
  ...overrides,
});

const query = (overrides: Partial<JobQueryValue> = {}): JobQueryValue => ({
  limit: 50,
  maxAgeDays: 30,
  offset: 0,
  regions: [],
  roles: [],
  search: "",
  sort: "Newest",
  ...overrides,
});

const withStore = <A, E>(body: Effect.Effect<A, E, JobStore>) =>
  Effect.gen(function* runWithStore() {
    const layer = yield* sqlJsJobStore;

    return yield* body.pipe(Effect.provide(layer));
  });

const ids = (jobs: readonly JobValue[]) => pipe(jobs, Array.map((found) => found.id)).toSorted();

describe("D1 job store queries", () => {
  it.effect("replacing a feed keeps listed jobs, drops unlisted ones, and leaves other feeds alone", () =>
    withStore(
      Effect.gen(function* replaceFeeds() {
        const store = yield* JobStore;

        yield* store.replaceFeed("a", [job({ feed: "a", id: "a:1" }), job({ feed: "a", id: "a:2", title: "Director of Engineering" })], NOW);
        yield* store.replaceFeed("b", [job({ company: "Globex", feed: "b", id: "b:1" })], NOW);

        const replaced = yield* store.replaceFeed(
          "a",
          [job({ feed: "a", firstSeenAt: NOW + 10, id: "a:2", lastSeenAt: NOW + 10, postedAt: NOW + 10, title: "Director of Engineering" })],
          NOW + 10
        );

        const listing = yield* store.list(query(), NOW + 20);

        expect(replaced).toStrictEqual({ removed: 1, upserted: 1 });
        expect(ids(listing.jobs)).toStrictEqual(["a:2", "b:1"]);

        const kept = pipe(Array.findFirst(listing.jobs, (found) => found.id === "a:2"), Option.map((found) => [found.firstSeenAt, found.postedAt]));

        expect(kept).toStrictEqual(Option.some([NOW, NOW]));
      })
    )
  );

  it.effect("the same role from a company board and an aggregator is listed once, from the board", () =>
    withStore(
      Effect.gen(function* dedupe() {
        const store = yield* JobStore;

        yield* store.replaceFeed("remoteok:all", [job({ feed: "remoteok:all", id: "r:1", source: "RemoteOK", title: "Engineering  Manager" })], NOW);
        yield* store.replaceFeed("greenhouse:acme", [job({ feed: "greenhouse:acme", id: "g:1" })], NOW);

        const listing = yield* store.list(query(), NOW);

        expect(ids(listing.jobs)).toStrictEqual(["g:1"]);
        expect(listing.total).toBe(1);
      })
    )
  );

  it.effect("filters respect age, role, region and a search containing LIKE wildcards", () =>
    withStore(
      Effect.gen(function* filter() {
        const store = yield* JobStore;

        yield* store.replaceFeed(
          "a",
          [
            job({ feed: "a", id: "a:old", postedAt: NOW - 10 * DAY_MILLIS, title: "Old Engineering Manager" }),
            job({ feed: "a", id: "a:vp", role: "VicePresident", title: "VP Engineering" }),
            job({ company: "100%_Co", feed: "a", id: "a:bc", region: "BritishColumbia", title: "EM Platform" }),
          ],
          NOW
        );

        const week = yield* store.list(query({ maxAgeDays: 7 }), NOW);
        const vp = yield* store.list(query({ roles: ["VicePresident"] }), NOW);
        const bc = yield* store.list(query({ regions: ["BritishColumbia"] }), NOW);
        const search = yield* store.list(query({ search: "100%_" }), NOW);

        expect(ids(week.jobs)).toStrictEqual(["a:bc", "a:vp"]);
        expect(ids(vp.jobs)).toStrictEqual(["a:vp"]);
        expect(ids(bc.jobs)).toStrictEqual(["a:bc"]);
        expect(ids(search.jobs)).toStrictEqual(["a:bc"]);
      })
    )
  );

  it.effect("relevance ranks a fresh role above a stale one with the same score", () =>
    withStore(
      Effect.gen(function* rank() {
        const store = yield* JobStore;

        yield* store.replaceFeed(
          "a",
          [
            job({ feed: "a", id: "a:stale", postedAt: NOW - 5 * DAY_MILLIS, title: "Engineering Manager, Data" }),
            job({ feed: "a", id: "a:fresh", title: "Engineering Manager, Growth" }),
          ],
          NOW
        );

        const listing = yield* store.list(query({ sort: "Relevance" }), NOW);

        expect(pipe(listing.jobs, Array.map((found) => found.id))).toStrictEqual(["a:fresh", "a:stale"]);
      })
    )
  );

  it.effect("pruning removes roles past the retention window and failures accumulate on a feed", () =>
    withStore(
      Effect.gen(function* prune() {
        const store = yield* JobStore;

        yield* store.replaceFeed(
          "a",
          [job({ feed: "a", id: "a:1", postedAt: NOW - 40 * DAY_MILLIS }), job({ feed: "a", id: "a:2" })],
          NOW
        );

        const pruned = yield* store.pruneOlderThan(NOW - 30 * DAY_MILLIS);

        yield* store.recordFeedFailure("b", NOW, "timeout");
        yield* store.recordFeedFailure("b", NOW + 1, "timeout");

        const states = yield* store.feedStates;
        const stats = yield* store.stats(NOW);

        expect(pruned).toBe(1);
        expect(pipe(states, Array.map((state) => [state.key, state.consecutiveFailures]))).toStrictEqual([
          ["a", 0],
          ["b", 2],
        ]);
        expect([stats.activeJobs, stats.feedsTotal, stats.feedsFailing]).toStrictEqual([1, 2, 1]);
      })
    )
  );
});
