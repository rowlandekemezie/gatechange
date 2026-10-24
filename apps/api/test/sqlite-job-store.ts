// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test loads checked-in migrations into an isolated SQLite database.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { JobStoreUnavailable } from "@rat-stack/core";
import {
  jobStoreLayer,
  jobStoreMigrationDirectory,
  SqlExecutor,
} from "@rat-stack/job-store";
import { Effect, Layer, Schema } from "effect";

export const migratedDatabase = () => {
  const database = new DatabaseSync(":memory:");
  const directory = jobStoreMigrationDirectory();

  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    database.exec(readFileSync(`${directory}${file}`, "utf-8"));
  }

  return database;
};

export const storeOn = (database: DatabaseSync) =>
  jobStoreLayer.pipe(
    Layer.provide(
      Layer.succeed(
        SqlExecutor,
        SqlExecutor.of({
          all: (operation, sql, row) =>
            Schema.decodeEffect(Schema.Array(row))(
              database.prepare(sql.sql).all(...sql.params)
            ).pipe(
              Effect.mapError(
                (failure) =>
                  new JobStoreUnavailable({
                    message: failure.message,
                    operation,
                  })
              )
            ),
          batch: (_operation, statements) =>
            Effect.sync(() => {
              database.exec("BEGIN");

              try {
                const results = statements.map((sql) => ({
                  changes: Number(
                    database.prepare(sql.sql).run(...sql.params).changes
                  ),
                }));

                database.exec("COMMIT");

                return results;
              } catch (error) {
                database.exec("ROLLBACK");
                throw error;
              }
            }),
        })
      )
    )
  );
