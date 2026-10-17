// @effect-diagnostics-next-line nodeBuiltinImport:off -- The migration test reads the checked-in migration SQL before any Effect runs.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { DAY_MILLIS, JobStore, SalaryBand, SalaryFloor } from "@rat-stack/core";
import type {
  EnrichmentValue,
  JobQueryValue,
  JobValue,
  SalaryBandValue,
  SalaryFloorValue,
} from "@rat-stack/core";
import { Array, Effect, Option, pipe, Schema } from "effect";
import initSqlJs from "sql.js";

import {
  jobStoreMigrationDirectory,
  makeJobStore,
  SqlExecutor,
  statement,
} from "../src/index.js";
import type { SqlStatement } from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const job = (id: string, overrides: Partial<JobValue> = {}): JobValue => ({
  arrangement: "Remote",
  company: `Company ${id}`,
  feed: "greenhouse:acme",
  firstSeenAt: NOW,
  id,
  lastSeenAt: NOW,
  location: "Remote - Canada",
  postedAt: NOW,
  region: "RemoteCanada",
  relevance: 50,
  role: "EngineeringManager",
  salary: null,
  source: "Greenhouse",
  title: "Engineering Manager",
  url: `https://jobs.example/${id}`,
  ...overrides,
});

const enrichment = (
  overrides: Partial<EnrichmentValue> = {}
): EnrichmentValue => ({
  enrichedAt: NOW + 1,
  model: "test-model",
  remotePolicy: "RemoteInRegion",
  reportsTo: "VP of Engineering",
  salary: { currency: "USD", max: 220_000, min: 180_000 },
  seniority: "Director",
  teamSize: 24,
  ...overrides,
});

const bare: EnrichmentValue = {
  enrichedAt: NOW + 2,
  model: "test-model",
  remotePolicy: null,
  reportsTo: null,
  salary: null,
  seniority: null,
  teamSize: null,
};

const query = (overrides: Partial<JobQueryValue> = {}): JobQueryValue => ({
  limit: 100,
  maxAgeDays: 30,
  offset: 0,
  regions: [],
  roles: [],
  salaryFloor: null,
  search: "",
  seniorities: [],
  sort: "Newest",
  ...overrides,
});

const withStore = <A, E>(body: Effect.Effect<A, E, JobStore | SqlExecutor>) =>
  Effect.gen(function* runWithStore() {
    const layer = yield* sqlJsJobStore;

    return yield* body.pipe(Effect.provide(layer));
  });

const listedIds = (listQuery: JobQueryValue) =>
  Effect.gen(function* listIds() {
    const store = yield* JobStore;
    const page = yield* store.list(listQuery, NOW);

    return {
      ids: pipe(
        page.jobs,
        Array.map((listed) => listed.id)
      ).toSorted(),
      total: page.total,
    };
  });

const EnrichmentIdRow = Schema.Struct({ job_id: Schema.String });

const enrichedIds = Effect.gen(function* enrichedIds() {
  const sql = yield* SqlExecutor;

  const rows = yield* sql.all(
    "enrichedIds",
    statement("SELECT job_id FROM job_enrichment ORDER BY job_id"),
    EnrichmentIdRow
  );

  return rows.map((row) => row.job_id);
});

const migration = (file: string) =>
  readFileSync(`${jobStoreMigrationDirectory()}${file}`, "utf-8");

const legacyTables = ["jobs", "feeds", "job_history", "ingest_runs"] as const;

describe("migration 0003", () => {
  it.effect(
    "applies on top of a populated 0002 database without touching existing rows",
    () =>
      Effect.gen(function* migrate() {
        // @effect-diagnostics-next-line asyncFunction:off -- sql.js only exposes a Promise-based loader.
        const SQL = yield* Effect.promise(async () => await initSqlJs());
        const database = new SQL.Database();

        database.run(migration("0001_jobs.sql"));
        database.run(`
INSERT INTO jobs VALUES
  ('a:1', 'a', 'Greenhouse', 'Engineering Manager', 'Acme', 'Remote', 'RemoteCanada', 'Remote', 'EngineeringManager', 'https://a/1', '$200k', 70, 10, 10, 20, 'acme|engineering manager'),
  ('b:1', 'b', 'RemoteOK', 'Director', 'Globex', 'Toronto', 'Ontario', 'Hybrid', 'Director', 'https://b/1', NULL, 40.5, 11, 11, 21, 'globex|director');
INSERT INTO feeds VALUES ('a', 20, 20, NULL, 0), ('b', 21, NULL, 'down', 3);
INSERT INTO ingest_runs VALUES (5, 6, 2, 1, 2, 0, 'Partial');`);
        database.run(migration("0002_job_history.sql"));
        database.run(
          "UPDATE feeds SET previous_success_at = 15 WHERE key = 'a'; UPDATE job_history SET sightings = 4, reposts = 1 WHERE fingerprint = 'globex|director'"
        );

        const snapshot = () =>
          pipe(
            legacyTables,
            Array.map((table) => database.exec(`SELECT * FROM ${table}`))
          );

        const before = snapshot();

        database.run(migration("0003_job_enrichment.sql"));

        expect(snapshot()).toStrictEqual(before);
        expect(
          pipe(
            before,
            Array.map((result) => result[0]?.values.length ?? 0)
          )
        ).toStrictEqual([2, 2, 2, 1]);
        expect(
          database.exec("SELECT COUNT(*) FROM job_enrichment")[0]?.values
        ).toStrictEqual([[0]]);

        database.close();
      })
  );
});

const Listing = Schema.Struct({
  band: Schema.NullOr(SalaryBand),
  enriched: Schema.Boolean,
});

const Listings = Schema.Array(Listing).check(Schema.isMaxLength(12));

type ListingValue = typeof Listing.Type;

const meetsFloor = (floor: SalaryFloorValue, band: SalaryBandValue | null) =>
  band !== null && band.currency === floor.currency && band.max >= floor.amount;

const floorFor = (
  floor: SalaryFloorValue,
  atBoundary: boolean,
  listings: readonly ListingValue[]
): SalaryFloorValue =>
  pipe(
    Array.findFirst(listings, (listing) => listing.band !== null),
    Option.flatMap((listing) => Option.fromNullishOr(listing.band)),
    Option.filter(() => atBoundary),
    Option.match({
      onNone: () => floor,
      onSome: (band) => ({ amount: band.max, currency: band.currency }),
    })
  );

describe("enrichment filters", () => {
  it.effect.prop(
    "a salary floor keeps exactly the enriched rows whose band in that currency reaches it",
    { atBoundary: Schema.Boolean, floor: SalaryFloor, listings: Listings },
    ({ atBoundary, floor, listings }) =>
      withStore(
        Effect.gen(function* salaryFloor() {
          const store = yield* JobStore;
          const active = floorFor(floor, atBoundary, listings);

          const rows = listings.map((listing, index) => ({
            id: `job:${String(index).padStart(2, "0")}`,
            listing,
          }));

          yield* store.replaceFeed(
            "greenhouse:acme",
            rows.map((row) => job(row.id)),
            NOW
          );

          yield* Effect.forEach(
            rows.filter((row) => row.listing.enriched),
            (row) =>
              store.saveEnrichment(
                row.id,
                enrichment({ salary: row.listing.band })
              ),
            { discard: true }
          );

          const expected = pipe(
            rows,
            Array.filter(
              (row) =>
                row.listing.enriched && meetsFloor(active, row.listing.band)
            ),
            Array.map((row) => row.id)
          );

          const found = yield* listedIds(query({ salaryFloor: active }));

          expect(found.ids).toStrictEqual(expected);
          expect(found.total).toBe(expected.length);
        })
      ),
    { timeout: 60_000 }
  );

  it.effect(
    "a salary floor keeps a band whose max equals it and drops other currencies and unenriched rows",
    () =>
      withStore(
        Effect.gen(function* salaryBoundary() {
          const store = yield* JobStore;

          yield* store.replaceFeed(
            "greenhouse:acme",
            [job("at"), job("below"), job("cad"), job("none"), job("plain")],
            NOW
          );
          yield* store.saveEnrichment(
            "at",
            enrichment({
              salary: { currency: "USD", max: 200_000, min: 150_000 },
            })
          );
          yield* store.saveEnrichment(
            "below",
            enrichment({
              salary: { currency: "USD", max: 199_999, min: 199_999 },
            })
          );
          yield* store.saveEnrichment(
            "cad",
            enrichment({
              salary: { currency: "CAD", max: 400_000, min: 300_000 },
            })
          );
          yield* store.saveEnrichment("none", bare);

          const found = yield* listedIds(
            query({ salaryFloor: { amount: 200_000, currency: "USD" } })
          );

          expect(found).toStrictEqual({ ids: ["at"], total: 1 });
        })
      )
  );

  it.effect(
    "seniorities keep enriched rows at those levels, and an empty list restricts nothing",
    () =>
      withStore(
        Effect.gen(function* seniority() {
          const store = yield* JobStore;

          yield* store.replaceFeed(
            "greenhouse:acme",
            [job("dir"), job("vp"), job("mgr"), job("blank"), job("plain")],
            NOW
          );
          yield* store.saveEnrichment(
            "dir",
            enrichment({ seniority: "Director" })
          );
          yield* store.saveEnrichment(
            "vp",
            enrichment({ seniority: "VicePresident" })
          );
          yield* store.saveEnrichment(
            "mgr",
            enrichment({ seniority: "Manager" })
          );
          yield* store.saveEnrichment("blank", bare);

          const senior = yield* listedIds(
            query({ seniorities: ["Director", "VicePresident"] })
          );

          const everyone = yield* listedIds(query({ seniorities: [] }));

          expect(senior).toStrictEqual({ ids: ["dir", "vp"], total: 2 });
          expect(everyone).toStrictEqual({
            ids: ["blank", "dir", "mgr", "plain", "vp"],
            total: 5,
          });
        })
      )
  );
});

describe("enrichment storage", () => {
  it.effect(
    "newListings returns unenriched ids first seen at that run from the given sources, sorted",
    () =>
      withStore(
        Effect.gen(function* newListings() {
          const store = yield* JobStore;
          const seenAt = NOW + DAY_MILLIS;

          yield* store.replaceFeed(
            "greenhouse:acme",
            [job("g:old", { firstSeenAt: NOW })],
            NOW
          );
          yield* store.replaceFeed(
            "greenhouse:acme",
            [
              job("g:zeta", { firstSeenAt: seenAt, lastSeenAt: seenAt }),
              job("g:old", { firstSeenAt: seenAt, lastSeenAt: seenAt }),
              job("g:alpha", { firstSeenAt: seenAt, lastSeenAt: seenAt }),
              job("g:done", { firstSeenAt: seenAt, lastSeenAt: seenAt }),
            ],
            seenAt
          );
          yield* store.replaceFeed(
            "lever:acme",
            [
              job("l:mid", {
                feed: "lever:acme",
                firstSeenAt: seenAt,
                lastSeenAt: seenAt,
                source: "Lever",
              }),
            ],
            seenAt
          );
          yield* store.replaceFeed(
            "remoteok:all",
            [
              job("r:agg", {
                feed: "remoteok:all",
                firstSeenAt: seenAt,
                lastSeenAt: seenAt,
                source: "RemoteOK",
              }),
            ],
            seenAt
          );
          yield* store.replaceFeed(
            "greenhouse:globex",
            [
              job("g:later", {
                feed: "greenhouse:globex",
                firstSeenAt: seenAt + 1,
                lastSeenAt: seenAt + 1,
              }),
            ],
            seenAt + 1
          );
          yield* store.saveEnrichment("g:done", enrichment());

          const fresh = yield* store.newListings(seenAt, [
            "Greenhouse",
            "Lever",
          ]);

          expect(fresh).toStrictEqual(["g:alpha", "g:zeta", "l:mid"]);
        })
      )
  );

  it.effect(
    "saving an enrichment twice leaves one row holding the second value",
    () =>
      withStore(
        Effect.gen(function* upsert() {
          const store = yield* JobStore;

          const second = enrichment({
            enrichedAt: NOW + 9,
            model: "second-model",
            remotePolicy: "Onsite",
            reportsTo: "CTO",
            salary: { currency: "EUR", max: 150_000, min: 120_000 },
            seniority: "VicePresident",
            teamSize: 80,
          });

          yield* store.replaceFeed("greenhouse:acme", [job("a")], NOW);
          yield* store.saveEnrichment("a", enrichment());
          yield* store.saveEnrichment("a", second);

          const found = yield* store.find("a");

          expect(yield* enrichedIds).toStrictEqual(["a"]);
          expect(found).toStrictEqual(
            Option.some({ ...job("a"), enrichment: second })
          );
        })
      )
  );

  it.effect(
    "pruning drops enrichment rows whose job is gone and keeps the rest",
    () =>
      withStore(
        Effect.gen(function* prune() {
          const store = yield* JobStore;
          const cutoff = NOW - DAY_MILLIS;

          yield* store.replaceFeed(
            "greenhouse:acme",
            [
              job("old", { postedAt: cutoff - 1 }),
              job("kept"),
              job("delisted"),
            ],
            NOW
          );
          yield* Effect.forEach(
            ["old", "kept", "delisted"],
            (id) => store.saveEnrichment(id, enrichment()),
            { discard: true }
          );
          yield* store.replaceFeed(
            "greenhouse:acme",
            [
              job("old", { lastSeenAt: NOW + 1, postedAt: cutoff - 1 }),
              job("kept", { lastSeenAt: NOW + 1 }),
            ],
            NOW + 1
          );

          const pruned = yield* store.pruneOlderThan(cutoff);

          expect(pruned).toBe(1);
          expect(yield* enrichedIds).toStrictEqual(["kept"]);
        })
      )
  );

  it.effect(
    "list and find return the saved enrichment exactly, including a null salary",
    () =>
      withStore(
        Effect.gen(function* roundTrip() {
          const store = yield* JobStore;

          const full = enrichment({
            salary: { currency: "GBP", max: 140_000, min: 95_000 },
          });

          yield* store.replaceFeed(
            "greenhouse:acme",
            [job("full"), job("bare"), job("plain")],
            NOW
          );
          yield* store.saveEnrichment("full", full);
          yield* store.saveEnrichment("bare", bare);

          const page = yield* store.list(query(), NOW);

          const found = yield* Effect.forEach(["full", "bare", "plain"], (id) =>
            store.find(id)
          );

          expect(
            page.jobs
              .toSorted((left, right) => left.id.localeCompare(right.id))
              .map((listed) => [listed.id, listed.enrichment])
          ).toStrictEqual([
            ["bare", bare],
            ["full", full],
            ["plain", null],
          ]);
          expect(found).toStrictEqual([
            Option.some({ ...job("full"), enrichment: full }),
            Option.some({ ...job("bare"), enrichment: bare }),
            Option.some({ ...job("plain"), enrichment: null }),
          ]);
        })
      )
  );

  it.effect(
    "replacing a feed issues two statements per job plus two, as before enrichment",
    () =>
      withStore(
        Effect.gen(function* statementCount() {
          const inner = yield* SqlExecutor;
          const batches: (readonly SqlStatement[])[] = [];

          const store = yield* makeJobStore.pipe(
            Effect.provideService(
              SqlExecutor,
              SqlExecutor.of({
                all: inner.all,
                batch: (operation, statements) => {
                  batches.push(statements);

                  return inner.batch(operation, statements);
                },
              })
            )
          );

          const jobs = Array.makeBy(41, (index) => job(`job:${index}`));

          yield* store.replaceFeed("greenhouse:acme", jobs, NOW);

          expect(batches.map((batch) => batch.length)).toStrictEqual([
            80, 2, 2,
          ]);
        })
      )
  );
});
