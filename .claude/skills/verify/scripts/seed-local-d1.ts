import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { findLocalJobsDatabase, fixturePath } from "./local-d1.ts";
import { decodeFixture, FIXTURE_FEED_PREFIX, seedStatements } from "./seed.ts";

const checkOnly = process.argv.includes("--check");
const fixture = decodeFixture(JSON.parse(readFileSync(fixturePath, "utf8")));
const file = findLocalJobsDatabase();
const database = new DatabaseSync(file, { readOnly: checkOnly });

if (!checkOnly) {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of seedStatements(fixture, Date.now())) {
      database.prepare(statement.sql).run(...statement.params);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const seeded = database
  .prepare("SELECT count(*) AS n FROM jobs WHERE feed LIKE ?")
  .get(`${FIXTURE_FEED_PREFIX}%`) as { n: number };
database.close();

if (seeded.n !== fixture.jobs.length) {
  process.stderr.write(
    `local D1 holds ${seeded.n} fixture jobs but the fixture has ${fixture.jobs.length}\n`
  );
  process.exit(1);
}
process.stdout.write(
  `${checkOnly ? "found" : "seeded"} ${seeded.n} fixture jobs in ${file}\n`
);
