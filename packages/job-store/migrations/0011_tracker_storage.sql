CREATE TRIGGER tracked_jobs_storage_insert
BEFORE INSERT ON tracked_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM tracked_jobs
   WHERE account_id = NEW.account_id AND job_id = NEW.job_id
)
AND (
  SELECT COALESCE(SUM(length(CAST(job_id AS BLOB)) + length(CAST(notes AS BLOB)) + length(CAST(title AS BLOB)) + length(CAST(company AS BLOB)) + length(CAST(location AS BLOB)) + length(CAST(url AS BLOB))), 0)
    FROM tracked_jobs WHERE account_id = NEW.account_id
) + length(CAST(NEW.job_id AS BLOB)) + length(CAST(NEW.notes AS BLOB)) + length(CAST(NEW.title AS BLOB)) + length(CAST(NEW.company AS BLOB)) + length(CAST(NEW.location AS BLOB)) + length(CAST(NEW.url AS BLOB)) > 4194304
BEGIN
  SELECT RAISE(ABORT, 'tracker_storage_full');
END;

CREATE TRIGGER tracked_jobs_storage_update
BEFORE UPDATE ON tracked_jobs
WHEN (length(CAST(NEW.job_id AS BLOB)) + length(CAST(NEW.notes AS BLOB)) + length(CAST(NEW.title AS BLOB)) + length(CAST(NEW.company AS BLOB)) + length(CAST(NEW.location AS BLOB)) + length(CAST(NEW.url AS BLOB))) > (length(CAST(OLD.job_id AS BLOB)) + length(CAST(OLD.notes AS BLOB)) + length(CAST(OLD.title AS BLOB)) + length(CAST(OLD.company AS BLOB)) + length(CAST(OLD.location AS BLOB)) + length(CAST(OLD.url AS BLOB)))
AND (
  SELECT COALESCE(SUM(length(CAST(job_id AS BLOB)) + length(CAST(notes AS BLOB)) + length(CAST(title AS BLOB)) + length(CAST(company AS BLOB)) + length(CAST(location AS BLOB)) + length(CAST(url AS BLOB))), 0)
    FROM tracked_jobs WHERE account_id = NEW.account_id
) - (length(CAST(OLD.job_id AS BLOB)) + length(CAST(OLD.notes AS BLOB)) + length(CAST(OLD.title AS BLOB)) + length(CAST(OLD.company AS BLOB)) + length(CAST(OLD.location AS BLOB)) + length(CAST(OLD.url AS BLOB))) + (length(CAST(NEW.job_id AS BLOB)) + length(CAST(NEW.notes AS BLOB)) + length(CAST(NEW.title AS BLOB)) + length(CAST(NEW.company AS BLOB)) + length(CAST(NEW.location AS BLOB)) + length(CAST(NEW.url AS BLOB))) > 4194304
BEGIN
  SELECT RAISE(ABORT, 'tracker_storage_full');
END;

CREATE TRIGGER tracked_jobs_new_id_limit
BEFORE INSERT ON tracked_jobs
WHEN length(CAST(NEW.job_id AS BLOB)) > 200
AND NOT EXISTS (
  SELECT 1 FROM tracked_jobs
   WHERE account_id = NEW.account_id AND job_id = NEW.job_id
)
BEGIN
  SELECT RAISE(ABORT, 'tracker_job_id_too_long');
END;
