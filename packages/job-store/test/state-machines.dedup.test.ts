import { describe, expect, it } from "@effect/vitest";
import {
  companySlugOf,
  fingerprintOf,
  JobStore,
  SourceName,
} from "@rat-stack/core";
import type { JobQueryValue, JobValue, SourceNameValue } from "@rat-stack/core";
import { Effect, Option, Schema } from "effect";

import { SqlExecutor, statement } from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const DAY = 86_400_000;

const job = (
  id: string,
  company: string,
  title: string,
  source: SourceNameValue = "Greenhouse"
): JobValue => ({
  arrangement: "Remote",
  company,
  feed: `${source.toLowerCase()}:fixture`,
  firstSeenAt: NOW,
  id,
  lastSeenAt: NOW,
  location: "Remote - Canada",
  postedAt: NOW,
  region: "RemoteCanada",
  relevance: 50,
  role: "EngineeringManager",
  salary: null,
  source,
  title,
  url: `https://jobs.example/${id}`,
});

const listAll: JobQueryValue = {
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

const withStore = <A, E>(body: Effect.Effect<A, E, JobStore | SqlExecutor>) =>
  Effect.gen(function* provideStore() {
    const base = yield* sqlJsJobStore;

    return yield* body.pipe(Effect.provide(base));
  });

const listedIds = (jobs: readonly JobValue[]) =>
  Effect.gen(function* listJobs() {
    const store = yield* JobStore;

    for (const listed of jobs) {
      yield* store.replaceFeed(listed.feed, [listed], NOW);
    }

    const listing = yield* store.list(listAll, NOW, SourceName.literals);

    return listing.jobs.map((listed) => listed.id).toSorted();
  });

const KeyRow = Schema.Struct({ fingerprint: Schema.String });

const keysIn = (table: "intel_history" | "job_history") =>
  SqlExecutor.use((sql) =>
    sql.all(
      "keys",
      statement(`SELECT fingerprint FROM ${table} ORDER BY fingerprint`),
      KeyRow
    )
  ).pipe(Effect.map((rows) => rows.map((row) => row.fingerprint)));

describe("server dedup fingerprint", () => {
  it.effect("two companies written in another script stay two roles", () =>
    withStore(
      Effect.gen(function* nonLatin() {
        expect(
          yield* listedIds([
            job("a", "株式会社メルカリ", "Engineering Manager"),
            job("b", "ソニー株式会社", "Engineering Manager", "Ashby"),
          ])
        ).toEqual(["a", "b"]);
      })
    )
  );

  it.effect("a C++ role and a C role stay two roles", () =>
    withStore(
      Effect.gen(function* symbols() {
        expect(
          yield* listedIds([
            job("a", "Acme", "Engineering Manager, C++"),
            job("b", "Acme", "Engineering Manager, C", "Lever"),
          ])
        ).toEqual(["a", "b"]);
      })
    )
  );

  it.effect(
    "text moved across the company and title separator stays two roles",
    () =>
      withStore(
        Effect.gen(function* separator() {
          expect(
            yield* listedIds([
              job("a", "Acme | Labs", "Engineering Manager"),
              job("b", "Acme", "Labs | Engineering Manager", "Lever"),
            ])
          ).toEqual(["a", "b"]);
        })
      )
  );

  it.effect(
    "one role posted with different spacing, case and punctuation is still one role",
    () =>
      withStore(
        Effect.gen(function* sameRole() {
          expect(
            yield* listedIds([
              job("a", "Pokémon Company", "Engineering Manager, Platform"),
              job(
                "b",
                "POKÉMON  company",
                "Engineering Manager - Platform",
                "Lever"
              ),
              job(
                "c",
                "Ｐｏｋéｍｏｎ Company",
                "Engineering Manager (Platform)",
                "Ashby"
              ),
            ])
          ).toEqual(["a"]);
        })
      )
  );

  it("plain ASCII roles keep the key they had before the fix", () => {
    expect(
      fingerprintOf({
        company: "Acme, Inc.",
        title: "Sr. Engineering Manager | Payments (Remote)",
      })
    ).toBe("acmeinc|srengineeringmanager|paymentsremote");
  });

  it.effect(
    "a role whose key changed keeps its history and leaves no stale history row",
    () =>
      withStore(
        Effect.gen(function* rekeyed() {
          const sql = yield* SqlExecutor;
          const store = yield* JobStore;
          const role = job("a", "The Pokémon Company", "Engineering Manager");
          const slug = Option.getOrElse(companySlugOf(role.company), () => "");

          yield* sql.batch("seedHistory", [
            statement(
              `INSERT INTO job_history (fingerprint, first_seen_at, last_seen_at, last_seen_feed, sightings, reposts)
VALUES ('thepokmoncompany|engineeringmanager', ?, ?, ?, 4, 2)`,
              [NOW - 20 * DAY, NOW - DAY, role.feed]
            ),
            statement(
              `INSERT INTO intel_history (company_slug, fingerprint, company, first_seen_at, stint_started_at, last_seen_at, last_seen_feed, reposts)
VALUES (?, 'thepokmoncompany|engineeringmanager', ?, ?, ?, ?, ?, 2)`,
              [
                slug,
                role.company,
                NOW - 20 * DAY,
                NOW - 10 * DAY,
                NOW - DAY,
                role.feed,
              ]
            ),
          ]);

          yield* store.replaceFeed(role.feed, [role], NOW);

          const history = yield* store.historyOf(role);

          expect(Option.getOrUndefined(history)).toMatchObject({
            firstSeenAt: NOW - 20 * DAY,
            reposts: 2,
          });
          expect(yield* keysIn("job_history")).toEqual([fingerprintOf(role)]);
          expect(yield* keysIn("intel_history")).toEqual([fingerprintOf(role)]);
        })
      )
  );
});
