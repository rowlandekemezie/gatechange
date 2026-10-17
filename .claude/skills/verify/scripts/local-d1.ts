import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const repoRoot = resolve(import.meta.dirname, "../../../..");

const d1Directory = join(
  repoRoot,
  "apps/infra/.alchemy/local/d1/cloudflare-runtime-D1DatabaseObject"
);

const hasJobsTable = (file: string) => {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
        .all("table", "jobs").length === 1
    );
  } finally {
    database.close();
  }
};

export const findLocalJobsDatabase = (): string => {
  if (!existsSync(d1Directory)) {
    throw new Error(
      `No local D1 at ${d1Directory}. Start the board with up.sh first.`
    );
  }
  const candidates = readdirSync(d1Directory)
    .filter((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite")
    .map((file) => join(d1Directory, file))
    .filter(hasJobsTable);
  const newest = candidates
    .map((file) => ({ file, touched: lastTouched(file) }))
    .toSorted((left, right) => right.touched - left.touched)[0];
  if (newest === undefined) {
    throw new Error(
      `No local D1 with a jobs table in ${d1Directory}. Start the board with up.sh first.`
    );
  }
  return newest.file;
};

const lastTouched = (file: string) =>
  Math.max(
    ...["", "-wal", "-shm"]
      .map((suffix) => `${file}${suffix}`)
      .filter((path) => existsSync(path))
      .map((path) => statSync(path).mtimeMs)
  );

export const fixturePath = resolve(
  import.meta.dirname,
  "../fixtures/jobs.json"
);
