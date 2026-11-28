// @effect-diagnostics-next-line nodeBuiltinImport:off -- The drift test reads the checked-in Lean fixture file once before any Effect runs.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import {
  backoffMinutes,
  fingerprintOf,
  JobStore,
  Region,
  regionsOfSelection,
  regionWeight,
  RoleLevel,
  roleWeight,
  selectDueFeeds,
  SourceName,
} from "@rat-stack/core";
import type {
  FeedRef,
  FeedStateValue,
  JobQueryValue,
  JobValue,
} from "@rat-stack/core";
import { Array, Effect, Option, pipe, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";

import { sqlJsJobStore } from "./sqljs-executor.js";

const FeedCase = Schema.Struct({
  backoffMinutes: Schema.Array(Schema.Finite),
  catalog: Schema.Array(
    Schema.Struct({ key: Schema.String, minIntervalMinutes: Schema.Finite })
  ),
  limit: Schema.Finite,
  now: Schema.Finite,
  selected: Schema.Array(Schema.String),
  states: Schema.Array(
    Schema.Struct({
      consecutiveFailures: Schema.Finite,
      key: Schema.String,
      lastAttemptAt: Schema.NullOr(Schema.Finite),
    })
  ),
});

const ListingCase = Schema.Struct({
  relevanceOrder: Schema.Array(Schema.String),
  rows: Schema.Array(
    Schema.Struct({
      company: Schema.String,
      id: Schema.String,
      postedAt: Schema.Finite,
      relevance: Schema.Finite,
      source: SourceName,
      title: Schema.String,
    })
  ),
});

const Fixtures = Schema.Struct({
  feeds: Schema.Array(FeedCase),
  fingerprints: Schema.Array(
    Schema.Struct({
      company: Schema.String,
      fingerprint: Schema.String,
      title: Schema.String,
    })
  ),
  listings: Schema.Array(ListingCase),
  regionWeights: Schema.Array(
    Schema.Struct({ region: Region, weight: Schema.Finite })
  ),
  roleWeights: Schema.Array(
    Schema.Struct({ role: RoleLevel, weight: Schema.Finite })
  ),
  segments: Schema.Array(
    Schema.Struct({ id: Schema.String, segment: Schema.String })
  ),
  selections: Schema.Array(
    Schema.Struct({
      regions: Schema.Array(Region),
      selection: Schema.Array(Region),
    })
  ),
});

const fixtures = Schema.decodeSync(Schema.fromJsonString(Fixtures))(
  readFileSync(
    new URL("../../../verify/lean/fixtures/gate-verify.json", import.meta.url),
    "utf-8"
  )
);

const NOW = 1_760_000_000_000;

const feedRef = (feed: {
  readonly key: string;
  readonly minIntervalMinutes: number;
}): FeedRef => ({
  company: Option.none(),
  coverage: "Window",
  key: feed.key,
  minIntervalMinutes: feed.minIntervalMinutes,
  source: "Greenhouse",
});

const feedState = (state: {
  readonly consecutiveFailures: number;
  readonly key: string;
  readonly lastAttemptAt: number | null;
}): FeedStateValue => ({
  consecutiveFailures: state.consecutiveFailures,
  key: state.key,
  lastAttemptAt: state.lastAttemptAt,
  lastError: null,
  lastSuccessAt: null,
});

const listingJob = (row: (typeof ListingCase.Type)["rows"][number]) => ({
  arrangement: "Remote" as const,
  company: row.company,
  feed: `${row.source.toLowerCase()}:fixture`,
  firstSeenAt: NOW,
  id: row.id,
  lastSeenAt: NOW,
  location: "Remote - Canada",
  postedAt: row.postedAt,
  region: "RemoteCanada" as const,
  relevance: row.relevance,
  role: "EngineeringManager" as const,
  salary: null,
  source: row.source,
  title: row.title,
  url: `https://jobs.example/${row.id}`,
});

const relevanceQuery: JobQueryValue = {
  limit: 50,
  maxAgeDays: 30,
  offset: 0,
  regions: [],
  roles: [],
  salaryFloor: null,
  salaryListed: false,
  search: "",
  seniorities: [],
  sort: "Relevance",
};

const listedOrder = (rows: (typeof ListingCase.Type)["rows"]) =>
  Effect.gen(function* listFixture() {
    const layer = yield* sqlJsJobStore;

    return yield* Effect.gen(function* replaceAndList() {
      const store = yield* JobStore;
      const jobs: JobValue[] = rows.map(listingJob);

      const byFeed = Array.groupBy(jobs, (job) => job.feed);

      yield* Effect.forEach(Object.entries(byFeed), ([feed, feedJobs]) =>
        store.replaceFeed(feed, feedJobs, NOW)
      );

      const listed = yield* store.list(
        relevanceQuery,
        NOW,
        SourceName.literals
      );

      return listed.jobs.map((job) => job.id);
    }).pipe(Effect.provide(layer));
  });

describe("Lean fixtures match the TypeScript rules", () => {
  it("selectDueFeeds and backoffMinutes pick what the Lean copy picks", () => {
    expect(fixtures.feeds.length).toBeGreaterThan(0);

    for (const fixture of fixtures.feeds) {
      const catalog = fixture.catalog.map(feedRef);
      const states = fixture.states.map(feedState);

      expect(
        selectDueFeeds(catalog, states, fixture.now, fixture.limit).map(
          (feed) => feed.key
        )
      ).toStrictEqual(fixture.selected);

      expect(
        catalog.map((feed) =>
          backoffMinutes(
            feed,
            Array.findFirst(states, (state) => state.key === feed.key)
          )
        )
      ).toStrictEqual(fixture.backoffMinutes);
    }
  });

  it("fingerprintOf gives the Lean fingerprint, former collisions included", () => {
    for (const { company, fingerprint, title } of fixtures.fingerprints) {
      expect(fingerprintOf({ company, title })).toBe(fingerprint);
    }
  });

  it("job id segments encode and decode as the Lean copy does", () => {
    for (const { id, segment } of fixtures.segments) {
      expect(Base64Url.encode(id)).toBe(segment);
      expect(Result.getSuccess(Base64Url.decodeString(segment))).toStrictEqual(
        Option.some(id)
      );
    }
  });

  it("role and region weights match the Lean tables", () => {
    for (const { role, weight } of fixtures.roleWeights) {
      expect(roleWeight(role)).toBe(weight);
    }

    for (const { region, weight } of fixtures.regionWeights) {
      expect(regionWeight(region)).toBe(weight);
    }
  });

  it("regionsOfSelection expands groups as the Lean copy does", () => {
    for (const { regions, selection } of fixtures.selections) {
      expect(regionsOfSelection(selection)).toStrictEqual(regions);
    }
  });

  it.effect(
    "listJobs collapses duplicates and ranks by relevance as the Lean copy does",
    () =>
      pipe(
        fixtures.listings,
        Effect.forEach((fixture) =>
          pipe(
            listedOrder(fixture.rows),
            Effect.tap((order) =>
              Effect.sync(() => {
                expect(order).toStrictEqual(fixture.relevanceOrder);
              })
            )
          )
        )
      )
  );
});
