CREATE TABLE tracked_jobs (
  account_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (
    stage IN ('Saved', 'Applied', 'Interviewing', 'Offer', 'Rejected')
  ),
  notes TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL,
  url TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  moved_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, job_id)
) WITHOUT ROWID;
