CREATE TABLE intel_history (
  fingerprint TEXT PRIMARY KEY NOT NULL,
  company TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  stint_started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_seen_feed TEXT NOT NULL,
  reposts INTEGER NOT NULL,
  previous_started_at INTEGER,
  previous_ended_at INTEGER
);

CREATE INDEX intel_history_first_seen ON intel_history (first_seen_at);

INSERT INTO intel_history (fingerprint, company, first_seen_at, stint_started_at, last_seen_at, last_seen_feed, reposts)
WITH licensed AS (
  SELECT fingerprint, company, feed, first_seen_at, last_seen_at
  FROM jobs
  WHERE source NOT IN ('HackerNews', 'Remotive')
),
latest AS (
  SELECT fingerprint, MIN(first_seen_at) AS first_seen_at, MAX(last_seen_at) AS last_seen_at
  FROM licensed
  GROUP BY fingerprint
)
SELECT latest.fingerprint,
  (SELECT MIN(licensed.company) FROM licensed WHERE licensed.fingerprint = latest.fingerprint AND licensed.last_seen_at = latest.last_seen_at),
  latest.first_seen_at, latest.first_seen_at, latest.last_seen_at,
  (SELECT MIN(licensed.feed) FROM licensed WHERE licensed.fingerprint = latest.fingerprint AND licensed.last_seen_at = latest.last_seen_at),
  0
FROM latest;
