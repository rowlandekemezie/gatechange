import { Context } from "effect";
import type { Effect, Schema } from "effect";
import type { JobStoreUnavailable } from "@rat-stack/core";

export type SqlValue = number | string | null;

export interface SqlStatement {
  readonly params: ReadonlyArray<SqlValue>;
  readonly sql: string;
}

export interface StatementResult {
  readonly changes: number;
}

export type RowSchema = Schema.Top & {
  readonly DecodingServices: never;
};

export class SqlExecutor extends Context.Service<
  SqlExecutor,
  {
    readonly all: <S extends RowSchema>(
      operation: string,
      statement: SqlStatement,
      row: S
    ) => Effect.Effect<ReadonlyArray<S["Type"]>, JobStoreUnavailable>;
    readonly batch: (
      operation: string,
      statements: ReadonlyArray<SqlStatement>
    ) => Effect.Effect<ReadonlyArray<StatementResult>, JobStoreUnavailable>;
  }
>()("@rat-stack/job-store/SqlExecutor") {}

export const statement = (sql: string, params: ReadonlyArray<SqlValue> = []): SqlStatement => ({
  params,
  sql,
});
