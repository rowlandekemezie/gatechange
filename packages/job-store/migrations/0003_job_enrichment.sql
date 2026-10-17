CREATE TABLE job_enrichment (
  job_id TEXT PRIMARY KEY NOT NULL,
  salary_currency TEXT,
  salary_min INTEGER,
  salary_max INTEGER,
  seniority TEXT,
  team_size INTEGER,
  reports_to TEXT,
  remote_policy TEXT,
  model TEXT NOT NULL,
  enriched_at INTEGER NOT NULL,
  CHECK (
    (salary_currency IS NULL AND salary_min IS NULL AND salary_max IS NULL)
    OR (salary_currency IS NOT NULL AND salary_min IS NOT NULL AND salary_max IS NOT NULL)
  ),
  CHECK (salary_min <= salary_max)
);

CREATE INDEX job_enrichment_salary ON job_enrichment (salary_currency, salary_max);

CREATE INDEX job_enrichment_seniority ON job_enrichment (seniority);
