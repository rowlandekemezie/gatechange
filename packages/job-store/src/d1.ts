import * as Cloudflare from "alchemy/Cloudflare";
import * as RuntimeContext from "alchemy/RuntimeContext";
import { Array, Effect, Layer, Schema, pipe } from "effect";
import { JobStoreUnavailable } from "@rat-stack/core";

import { jobStoreMigrationDirectory } from "./migrations.js";
import { SqlExecutor } from "./sql-executor.js";
import type { SqlStatement } from "./sql-executor.js";
import { jobStoreLayer } from "./store.js";

const unavailable = (operation: string, reason: string) =>
  new JobStoreUnavailable({
    message: `The job store could not ${operation}: ${reason}`.slice(0, 500),
    operation,
  });

export const d1Executor = (client: Cloudflare.D1.QueryDatabaseClient) => {
  const prepared = (sql: SqlStatement) => client.prepare(sql.sql).bind(...sql.params);

  return SqlExecutor.of({
    all: (operation, sql, row) =>
      prepared(sql)
        .all()
        .pipe(
          Effect.provide(RuntimeContext.RuntimeContext.phantom),
          Effect.catchDefect((defect) => Effect.fail(unavailable(operation, String(defect)))),
          Effect.flatMap((result) =>
            Schema.decodeUnknownEffect(Schema.Array(row))(result.results).pipe(
              Effect.mapError((decodeFailure) => unavailable(operation, decodeFailure.message))
            )
          )
        ),
    batch: (operation, statements) =>
      Array.isReadonlyArrayNonEmpty(statements)
        ? client.batch(pipe(statements, Array.map(prepared))).pipe(
            Effect.provide(RuntimeContext.RuntimeContext.phantom),
            Effect.catchDefect((defect) => Effect.fail(unavailable(operation, String(defect)))),
            Effect.map(Array.map((result) => ({ changes: result.meta.changes ?? 0 })))
          )
        : Effect.succeed([]),
  });
};

export const JobsDatabase = Cloudflare.D1.Database("JobsDatabase", {
  migrations: jobStoreMigrationDirectory(),
  primaryLocationHint: "wnam",
});

export const d1JobStoreLayer = (client: Cloudflare.D1.QueryDatabaseClient) =>
  jobStoreLayer.pipe(Layer.provide(Layer.succeed(SqlExecutor, d1Executor(client))));
