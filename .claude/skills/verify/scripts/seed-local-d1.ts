// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- seed-local-d1.ts is standalone Node tooling that writes the stage's local D1 file with node:sqlite.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";

import { cliOptions, fixturePath, stageDatabasePath } from "./local-d1.ts";
import { decodeFixture, FIXTURE_FEED_PREFIX, seedStatements } from "./seed.ts";

const checkOnly = cliOptions.check === true;

const fixture = decodeFixture(JSON.parse(readFileSync(fixturePath, "utf-8")));

const file = stageDatabasePath();

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

const seeded = Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Finite }))(
  database
    .prepare("SELECT count(*) AS n FROM jobs WHERE feed LIKE ?")
    .get(`${FIXTURE_FEED_PREFIX}%`)
);

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
