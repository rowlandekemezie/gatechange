CREATE TABLE job_history (
  fingerprint TEXT PRIMARY KEY NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_seen_feed TEXT NOT NULL,
  sightings INTEGER NOT NULL,
  reposts INTEGER NOT NULL
);

ALTER TABLE feeds ADD COLUMN previous_success_at INTEGER;

INSERT INTO job_history (fingerprint, first_seen_at, last_seen_at, last_seen_feed, sightings, reposts)
WITH latest AS (
  SELECT fingerprint, MIN(first_seen_at) AS first_seen_at, MAX(last_seen_at) AS last_seen_at
  FROM jobs
  GROUP BY fingerprint
)
SELECT latest.fingerprint, latest.first_seen_at, latest.last_seen_at,
  (SELECT MIN(jobs.feed) FROM jobs WHERE jobs.fingerprint = latest.fingerprint AND jobs.last_seen_at = latest.last_seen_at),
  1, 0
FROM latest;
