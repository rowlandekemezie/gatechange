// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test reads the verify skill's checked-in fixture and migration SQL before any Effect runs.
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { DAY_MILLIS } from "@rat-stack/core";
import { Effect } from "effect";
import initSqlJs from "sql.js";

import {
  decodeFixture,
  seedStatements,
} from "../../../.claude/skills/verify/scripts/seed.js";
import { jobStoreMigrationDirectory } from "../src/index.js";

const NOW = 1_760_000_000_000;

const FIXTURE_JOBS = 100;

const fixture = decodeFixture(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../.claude/skills/verify/fixtures/jobs.json",
        import.meta.url
      ),
      "utf-8"
    )
  )
);

const migrationSql = readdirSync(jobStoreMigrationDirectory())
  .filter((file) => file.endsWith(".sql"))
  .toSorted()
  .map((file) =>
    readFileSync(`${jobStoreMigrationDirectory()}${file}`, "utf-8")
  )
  .join("\n");

const liveJob =
  "INSERT INTO jobs (id, feed, source, title, company, location, region, arrangement, role, url, salary, relevance, posted_at, first_seen_at, last_seen_at, fingerprint) VALUES ('live-1', 'greenhouse:acme', 'Greenhouse', 'Engineering Manager', 'Acme', 'Remote', 'RemoteCanada', 'Remote', 'EngineeringManager', 'https://jobs.example/1', NULL, 50, 0, 0, 0, 'acme|engineering manager')";

const count = (
  database: { exec: (sql: string) => { values: unknown[][] }[] },
  where: string
) =>
  Number(
    database.exec(`SELECT count(*) FROM jobs WHERE ${where}`)[0]?.values[0]?.[0]
  );

describe("verify skill seed", () => {
  it.effect(
    "loads every fixture job into a migrated D1 schema, twice without duplicates, and leaves live rows alone",
    () =>
      Effect.gen(function* seedIntoSqlJs() {
        // @effect-diagnostics-next-line asyncFunction:off -- sql.js only exposes a Promise-based loader.
        const SQL = yield* Effect.promise(async () => await initSqlJs());
        const database = new SQL.Database();

        database.run(migrationSql);
        database.run(liveJob);

        for (const run of [1, 2]) {
          for (const statement of seedStatements(fixture, NOW + run)) {
            database.run(statement.sql, [...statement.params]);
          }
        }

        expect(count(database, "feed LIKE 'fixture:%'")).toBe(FIXTURE_JOBS);
        expect(count(database, "id = 'live-1'")).toBe(1);
        expect(
          count(database, `posted_at >= ${NOW - 7 * DAY_MILLIS}`)
        ).toBeGreaterThanOrEqual(80);
      })
  );
});
