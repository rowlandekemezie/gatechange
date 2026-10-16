import type { JobStoreUnavailable } from "@rat-stack/core";
import { Context } from "effect";
import type { Effect, Schema } from "effect";

export type SqlValue = number | string | null;

export interface SqlStatement {
  readonly params: readonly SqlValue[];
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
    ) => Effect.Effect<readonly S["Type"][], JobStoreUnavailable>;
    readonly batch: (
      operation: string,
      statements: readonly SqlStatement[]
    ) => Effect.Effect<readonly StatementResult[], JobStoreUnavailable>;
  }
>()("@rat-stack/job-store/SqlExecutor") {}

export const statement = (
  sql: string,
  params: readonly SqlValue[] = []
): SqlStatement => ({
  params,
  sql,
});
