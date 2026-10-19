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

CREATE TRIGGER tracked_jobs_limit
BEFORE INSERT ON tracked_jobs
WHEN (
  SELECT COUNT(*) FROM tracked_jobs WHERE account_id = NEW.account_id
) >= 500
AND NOT EXISTS (
  SELECT 1 FROM tracked_jobs
   WHERE account_id = NEW.account_id AND job_id = NEW.job_id
)
BEGIN
  SELECT RAISE(ABORT, 'tracker_full');
END;
