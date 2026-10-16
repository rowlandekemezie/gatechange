CREATE TABLE jobs (
  id TEXT PRIMARY KEY NOT NULL,
  feed TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL,
  region TEXT NOT NULL,
  arrangement TEXT NOT NULL,
  role TEXT NOT NULL,
  url TEXT NOT NULL,
  salary TEXT,
  relevance REAL NOT NULL,
  posted_at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  fingerprint TEXT NOT NULL
);

CREATE INDEX jobs_posted_at ON jobs (posted_at DESC);

CREATE INDEX jobs_feed_seen ON jobs (feed, last_seen_at);

CREATE INDEX jobs_fingerprint ON jobs (fingerprint);

CREATE INDEX jobs_first_seen ON jobs (first_seen_at);

CREATE TABLE feeds (
  key TEXT PRIMARY KEY NOT NULL,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE ingest_runs (
  started_at INTEGER PRIMARY KEY NOT NULL,
  finished_at INTEGER NOT NULL,
  feeds_attempted INTEGER NOT NULL,
  feeds_failed INTEGER NOT NULL,
  jobs_upserted INTEGER NOT NULL,
  jobs_pruned INTEGER NOT NULL,
  outcome TEXT NOT NULL
);
