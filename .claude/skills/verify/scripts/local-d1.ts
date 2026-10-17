// @effect-diagnostics nodeBuiltinImport:off -- local-d1.ts is standalone Node tooling that opens a stage's local D1 file with node:sqlite.
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

export const fixturePath = path.resolve(
  import.meta.dirname,
  "../fixtures/jobs.json"
);

export const cliOptions = parseArgs({
  options: { check: { type: "boolean" }, db: { type: "string" } },
}).values;

export const stageDatabasePath = (): string => {
  const file = cliOptions.db;

  if (file === undefined || !existsSync(file)) {
    throw new Error(
      `--db must name the stage's local D1 file, which up.sh writes to /tmp/verify-jobs/<stage>/d1 (got ${file ?? "nothing"})`
    );
  }

  const database = new DatabaseSync(file, { readOnly: true });

  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
    .all("table", "jobs");

  database.close();

  if (tables.length !== 1) {
    throw new Error(`${file} has no jobs table`);
  }

  return file;
};
