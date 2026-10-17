// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test harness reads the checked-in migration SQL once before any Effect runs.
import { readdirSync, readFileSync } from "node:fs";

import { JobStoreUnavailable } from "@rat-stack/core";
import { Effect, Layer, Schema } from "effect";
import initSqlJs from "sql.js";

import {
  jobStoreLayer,
  jobStoreMigrationDirectory,
  SqlExecutor,
} from "../src/index.js";
import type { SqlStatement } from "../src/index.js";

const migrationSql = (seeds: Readonly<Record<string, string>>) =>
  readdirSync(jobStoreMigrationDirectory())
    .filter((file) => file.endsWith(".sql"))
    .toSorted()
    .map(
      (file) =>
        `${readFileSync(`${jobStoreMigrationDirectory()}${file}`, "utf-8")}\n${seeds[file] ?? ""}`
    )
    .join("\n");

const failure = (operation: string, cause: Error) =>
  new JobStoreUnavailable({ message: cause.message, operation });

export const seededSqlJsJobStore = Effect.fnUntraced(function* makeSqlJsStore(
  seeds: Readonly<Record<string, string>>
) {
  // @effect-diagnostics-next-line asyncFunction:off -- sql.js only exposes a Promise-based loader.
  const SQL = yield* Effect.promise(async () => await initSqlJs());
  const database = new SQL.Database();

  database.run(migrationSql(seeds));

  const executor = SqlExecutor.of({
    all: (operation, sql: SqlStatement, row) =>
      Effect.try({
        catch: (cause) =>
          failure(
            operation,
            cause instanceof Error ? cause : new Error(String(cause))
          ),
        try: () => {
          const prepared = database.prepare(sql.sql);

          const rows: Record<string, number | string | null | Uint8Array>[] =
            [];

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
            Effect.mapError((decodeFailure) =>
              failure(operation, decodeFailure)
            )
          )
        )
      ),
    batch: (operation, statements) =>
      Effect.try({
        catch: (cause) =>
          failure(
            operation,
            cause instanceof Error ? cause : new Error(String(cause))
          ),
        try: () =>
          statements.map((sql) => {
            database.run(sql.sql, [...sql.params]);

            return { changes: database.getRowsModified() };
          }),
      }),
  });

  return jobStoreLayer.pipe(
    Layer.provideMerge(Layer.succeed(SqlExecutor, executor))
  );
});

export const sqlJsJobStore = seededSqlJsJobStore({});
