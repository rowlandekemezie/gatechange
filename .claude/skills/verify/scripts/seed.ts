import { Schema } from "effect";

export const FIXTURE_FEED_PREFIX = "fixture:";

const HOUR_MILLIS = 3_600_000;

export const FixtureJob = Schema.Struct({
  ageHours: Schema.Finite,
  arrangement: Schema.String,
  company: Schema.String,
  feed: Schema.String,
  fingerprint: Schema.String,
  id: Schema.String,
  location: Schema.String,
  region: Schema.String,
  relevance: Schema.Finite,
  role: Schema.String,
  salary: Schema.NullOr(Schema.String),
  source: Schema.String,
  title: Schema.String,
  url: Schema.String,
});

export const Fixture = Schema.Struct({
  jobs: Schema.Array(FixtureJob),
  recordedOn: Schema.String,
});

export type FixtureValue = typeof Fixture.Type;

export const decodeFixture = Schema.decodeUnknownSync(Fixture);

export interface SeedStatement {
  readonly params: readonly (number | string | null)[];
  readonly sql: string;
}

const insertJob =
  "INSERT OR REPLACE INTO jobs (id, feed, source, title, company, location, region, arrangement, role, url, salary, relevance, posted_at, first_seen_at, last_seen_at, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

export const seedStatements = (
  fixture: FixtureValue,
  now: number
): readonly SeedStatement[] => [
  {
    params: [`${FIXTURE_FEED_PREFIX}%`],
    sql: "DELETE FROM jobs WHERE feed LIKE ?",
  },
  ...fixture.jobs.map((job) => {
    const postedAt = Math.round(now - job.ageHours * HOUR_MILLIS);

    return {
      params: [
        job.id,
        `${FIXTURE_FEED_PREFIX}${job.feed}`,
        job.source,
        job.title,
        job.company,
        job.location,
        job.region,
        job.arrangement,
        job.role,
        job.url,
        job.salary,
        job.relevance,
        postedAt,
        postedAt,
        now,
        job.fingerprint,
      ],
      sql: insertJob,
    };
  }),
];
