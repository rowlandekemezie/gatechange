CREATE TABLE job_history (
  fingerprint TEXT PRIMARY KEY NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  sightings INTEGER NOT NULL,
  reposts INTEGER NOT NULL
);

INSERT INTO job_history (fingerprint, first_seen_at, last_seen_at, sightings, reposts)
SELECT fingerprint, MIN(first_seen_at), MAX(last_seen_at), 1, 0
FROM jobs
GROUP BY fingerprint;
