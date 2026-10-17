import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { findLocalJobsDatabase, fixturePath } from "./local-d1.ts";
import { FIXTURE_FEED_PREFIX } from "./seed.ts";

const COMPANY_BOARDS = ["Ashby", "Greenhouse", "Lever"];
const BOARD_DEFAULT_REGIONS = [
  "RemoteCanada",
  "RemoteUnitedStates",
  "RemoteNorthAmerica",
  "RemoteGlobal",
  "BritishColumbia",
];
const OTHER_REGION_ROWS = 24;
const AGE_COMPRESSION = 4;
const HOUR_MILLIS = 3_600_000;

interface Row {
  readonly [column: string]: number | string | null;
}

const now = Date.now();
const database = new DatabaseSync(findLocalJobsDatabase(), { readOnly: true });
const rows = database
  .prepare(
    `SELECT * FROM jobs WHERE source IN (${COMPANY_BOARDS.map(() => "?").join(", ")}) AND feed NOT LIKE ? ORDER BY relevance DESC, id`
  )
  .all(...COMPANY_BOARDS, `${FIXTURE_FEED_PREFIX}%`) as Row[];
database.close();

const isDefaultRegion = (row: Row) =>
  BOARD_DEFAULT_REGIONS.includes(String(row.region));

const chosen = [
  ...rows.filter(isDefaultRegion),
  ...rows.filter((row) => !isDefaultRegion(row)).slice(0, OTHER_REGION_ROWS),
];

const jobs = chosen.map((row) => ({
  ageHours:
    Math.round(
      ((now - Number(row.posted_at)) / HOUR_MILLIS / AGE_COMPRESSION) * 10
    ) / 10,
  arrangement: row.arrangement,
  company: row.company,
  feed: row.feed,
  fingerprint: row.fingerprint,
  id: row.id,
  location: row.location,
  region: row.region,
  relevance: row.relevance,
  role: row.role,
  salary: row.salary,
  source: row.source,
  title: row.title,
  url: row.url,
}));

writeFileSync(
  fixturePath,
  `${JSON.stringify({ jobs, recordedOn: new Date(now).toISOString().slice(0, 10) }, null, 2)}\n`
);
process.stdout.write(`recorded ${jobs.length} jobs into ${fixturePath}\n`);
