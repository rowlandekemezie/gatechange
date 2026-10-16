// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test harness reads the checked-in migration SQL once before any Effect runs.
import { readdirSync, readFileSync } from "node:fs";

import { Effect, Layer, Schema } from "effect";
import initSqlJs from "sql.js";
import { JobStoreUnavailable } from "@rat-stack/core";

import { jobStoreLayer, jobStoreMigrationDirectory, SqlExecutor } from "../src/index.js";
import type { SqlStatement } from "../src/index.js";

const migrationSql = () =>
  readdirSync(jobStoreMigrationDirectory())
    .filter((file) => file.endsWith(".sql"))
    .toSorted()
    .map((file) => readFileSync(`${jobStoreMigrationDirectory()}${file}`, "utf8"))
    .join("\n");

export const sqlJsJobStore = Effect.gen(function* makeSqlJsStore() {
  const SQL = yield* Effect.promise(() => initSqlJs());
  const database = new SQL.Database();

  database.run(migrationSql());

  const failure = (operation: string, error: Error) =>
    new JobStoreUnavailable({ message: error.message, operation });

  const executor = SqlExecutor.of({
    all: (operation, sql: SqlStatement, row) =>
      Effect.try({
        catch: (error) => failure(operation, error instanceof Error ? error : new Error(String(error))),
        try: () => {
          const prepared = database.prepare(sql.sql);
          const rows: Array<Record<string, number | string | null | Uint8Array>> = [];

          prepared.bind([...sql.params]);

          while (prepared.step()) {
            rows.push(prepared.getAsObject());
          }

          prepared.free();

          return rows;
        },
      }).pipe(
        Effect.flatMap((rows) =>
          Schema.decodeUnknownEffect(Schema.Array(row))(rows).pipe(
            Effect.mapError((error) => failure(operation, error))
          )
        )
      ),
    batch: (operation, statements) =>
      Effect.try({
        catch: (error) => failure(operation, error instanceof Error ? error : new Error(String(error))),
        try: () =>
          statements.map((sql) => {
            database.run(sql.sql, [...sql.params]);

            return { changes: database.getRowsModified() };
          }),
      }),
  });

  return jobStoreLayer.pipe(Layer.provide(Layer.succeed(SqlExecutor, executor)));
});
