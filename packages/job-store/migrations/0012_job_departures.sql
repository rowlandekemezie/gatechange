ALTER TABLE jobs ADD COLUMN departed_at INTEGER;

CREATE INDEX jobs_last_seen ON jobs (last_seen_at);
