// @effect-diagnostics-next-line nodeBuiltinImport:off -- The deletion test applies the checked-in migrations to an isolated SQLite database that enforces foreign keys like D1.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import {
  AccountId,
  AgentTokenId,
  AgentTokenStore,
  AlertStore,
  JobStore,
  MAX_AGENT_TOKENS,
  MAX_SAVED_SEARCHES,
  TRACKER_LIMIT,
  TrackerStore,
} from "@rat-stack/core";
import type { Region, SearchFiltersValue } from "@rat-stack/core";
import { Array, Effect, Layer, Result, Schema } from "effect";

import {
  agentTokenStoreLayer,
  alertStoreLayer,
  jobStoreMigrationDirectory,
  SqlExecutor,
  statement,
} from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const ada = AccountId.make("user_ada");

const withStores = <A, E>(
  body: Effect.Effect<
    A,
    E,
    AgentTokenStore | AlertStore | JobStore | SqlExecutor | TrackerStore
  >
) =>
  Effect.gen(function* provideStores() {
    const base = yield* sqlJsJobStore;

    return yield* body.pipe(
      Effect.provide(
        Layer.mergeAll(agentTokenStoreLayer, alertStoreLayer).pipe(
          Layer.provideMerge(base)
        )
      )
    );
  });

const addAda = SqlExecutor.use((sql) =>
  sql.batch("addMember", [
    statement(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)`,
      [ada, ada, `${ada}@example.com`]
    ),
  ])
);

const CountRow = Schema.Struct({ n: Schema.Finite });

const countOf = (table: string) =>
  SqlExecutor.use((sql) =>
    sql.all(
      "count",
      statement(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`, [
        ada,
      ]),
      CountRow
    )
  ).pipe(Effect.map((rows) => rows[0]?.n ?? 0));

const searchRegions: readonly (typeof Region.Type)[] = [
  "RemoteCanada",
  "RemoteGlobal",
];

const filtersFor = (index: number): SearchFiltersValue => ({
  regions: [searchRegions[index % 2] ?? "RemoteGlobal"],
  roles: ["EngineeringManager"],
  search: `search ${index}`,
});

describe("server-caps model replay", () => {
  it.effect(
    "NeverOverCap: agent tokens requested from many tabs at once stop at the cap",
    () =>
      withStores(
        Effect.gen(function* tokens() {
          yield* addAda;
          const store = yield* AgentTokenStore;

          const issued = yield* Effect.forEach(
            Array.range(1, MAX_AGENT_TOKENS + 3),
            (index) =>
              store.issue(
                ada,
                {
                  createdAt: index,
                  id: AgentTokenId.make(`tok_${index}`),
                  label: `tab ${index}`,
                },
                `hash_${index}`,
                MAX_AGENT_TOKENS
              ),
            { concurrency: "unbounded" }
          );

          expect(issued.filter(Boolean)).toHaveLength(MAX_AGENT_TOKENS);
          expect(yield* countOf("agent_tokens")).toBe(MAX_AGENT_TOKENS);
        })
      )
  );

  it.effect(
    "NeverOverCap: a revoke frees exactly one slot for the next token",
    () =>
      withStores(
        Effect.gen(function* revokeThenIssue() {
          yield* addAda;
          const store = yield* AgentTokenStore;

          yield* Effect.forEach(
            Array.range(1, MAX_AGENT_TOKENS),
            (index) =>
              store.issue(
                ada,
                {
                  createdAt: index,
                  id: AgentTokenId.make(`tok_${index}`),
                  label: `tab ${index}`,
                },
                `hash_${index}`,
                MAX_AGENT_TOKENS
              ),
            { discard: true }
          );
          yield* store.revoke(ada, AgentTokenId.make("tok_1"));

          const again = yield* Effect.forEach(["a", "b"], (suffix) =>
            store.issue(
              ada,
              {
                createdAt: 99,
                id: AgentTokenId.make(`tok_${suffix}`),
                label: suffix,
              },
              `hash_${suffix}`,
              MAX_AGENT_TOKENS
            )
          );

          expect(again).toEqual([true, false]);
        })
      )
  );

  it.effect(
    "NeverOverCap: saved searches saved at once stop at the limit",
    () =>
      withStores(
        Effect.gen(function* searches() {
          yield* addAda;
          const store = yield* AlertStore;

          yield* Effect.forEach(
            Array.range(1, MAX_SAVED_SEARCHES + 4),
            (index) =>
              store.saveSearch(
                ada,
                filtersFor(index),
                index,
                MAX_SAVED_SEARCHES
              ),
            { concurrency: "unbounded" }
          );

          expect(yield* countOf("saved_searches")).toBe(MAX_SAVED_SEARCHES);
        })
      )
  );

  it.effect(
    "NeverOverCap: tracking past the tracker limit at once is refused",
    () =>
      withStores(
        Effect.gen(function* tracker() {
          yield* addAda;
          const store = yield* TrackerStore;

          const results = yield* Effect.forEach(
            Array.range(1, TRACKER_LIMIT + 3),
            (index) =>
              store
                .track(
                  ada,
                  {
                    jobId: `job-${index}`,
                    snapshot: {
                      company: "Acme",
                      location: "Remote",
                      title: "Engineering Manager",
                      url: `https://jobs.example/${index}`,
                    },
                    stage: "Saved",
                  },
                  index
                )
                .pipe(Effect.result),
            { concurrency: "unbounded" }
          );

          expect(results.filter(Result.isFailure)).toHaveLength(3);
          expect(yield* countOf("tracked_jobs")).toBe(TRACKER_LIMIT);
        })
      )
  );

  it.effect(
    "NeverOverCap: enrichment neuron claims at once never pass the daily budget",
    () =>
      withStores(
        Effect.gen(function* neurons() {
          const store = yield* JobStore;

          const claims = yield* Effect.forEach(
            Array.range(1, 10),
            () =>
              store.claimNeurons({ budget: 1000, day: 20_000, neurons: 300 }),
            { concurrency: "unbounded" }
          );

          expect(claims.filter(Boolean)).toHaveLength(3);
          expect(yield* store.neuronsClaimed(20_000)).toBe(900);
        })
      )
  );
});

const ForeignKey = Schema.Struct({
  on_delete: Schema.String,
  table: Schema.String,
});

describe("server-account-deletion", () => {
  it.effect(
    "NoLeftoverRows: every table that names a member cascades when the member row is deleted",
    () =>
      Effect.sync(() => {
        const database = new DatabaseSync(":memory:");
        const directory = jobStoreMigrationDirectory();

        for (const file of readdirSync(directory)
          .filter((name) => name.endsWith(".sql"))
          .toSorted()) {
          database.exec(readFileSync(`${directory}${file}`, "utf-8"));
        }

        const tables = database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
          )
          .all()
          .map((row) => String(row.name));

        const memberColumns = new Set(["account_id", "userId"]);

        const uncovered = tables.flatMap((table) => {
          const columns = database
            .prepare(`SELECT name FROM pragma_table_info('${table}')`)
            .all()
            .map((row) => String(row.name));

          const keys = database
            .prepare(`SELECT * FROM pragma_foreign_key_list('${table}')`)
            .all()
            .map((row) => Schema.decodeUnknownSync(ForeignKey)(row));

          const namesMember =
            table !== "user" &&
            columns.some((column) => memberColumns.has(column));

          return namesMember &&
            !keys.some(
              (key) => key.table === "user" && key.on_delete === "CASCADE"
            )
            ? [table]
            : [];
        });

        expect(uncovered).toEqual([]);

        database.exec(
          `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user_ada', 'Ada', 'ada@example.com', 1, 0, 0)`
        );
        database.exec(
          `INSERT INTO agent_tokens (id, account_id, label, secret_hash, created_at) VALUES ('tok', 'user_ada', 'cli', 'hash', 0)`
        );
        database.exec(
          `INSERT INTO subscriptions (subscription_id, account_id, plan, status, period_end, cancel_at_period_end, event_created, event_rank, event_id) VALUES ('sub', 'user_ada', 'Monthly', 'active', 1, 0, 1, 0, 'evt')`
        );
        database.exec(
          `INSERT INTO billing_customers (account_id, customer_id, linked_at) VALUES ('user_ada', 'cus', 0)`
        );
        database.exec(`DELETE FROM "user" WHERE id = 'user_ada'`);

        const left = ["agent_tokens", "subscriptions", "billing_customers"].map(
          (table) =>
            database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n
        );

        expect(left).toEqual([0, 0, 0]);
      })
  );
});
