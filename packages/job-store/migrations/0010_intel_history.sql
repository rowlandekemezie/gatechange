ALTER TABLE jobs ADD COLUMN company_slug TEXT NOT NULL DEFAULT '';

WITH RECURSIVE slugs (company, remaining, slug) AS (
  SELECT DISTINCT company, LOWER(REPLACE(REPLACE(company, 'K', 'k'), 'İ', 'i̇')), ''
  FROM jobs
  UNION ALL
  SELECT company, SUBSTR(remaining, 2), slug || CASE
    WHEN SUBSTR(remaining, 1, 1) GLOB '[a-z0-9]' THEN SUBSTR(remaining, 1, 1)
    WHEN slug != '' AND SUBSTR(slug, -1) != '-' THEN '-'
    ELSE ''
  END
  FROM slugs
  WHERE remaining != ''
)
UPDATE jobs SET company_slug = (SELECT RTRIM(slugs.slug, '-') FROM slugs WHERE slugs.company = jobs.company AND slugs.remaining = '');

CREATE INDEX jobs_company_slug ON jobs (company_slug, posted_at);

CREATE TABLE intel_history (
  company_slug TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  company TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  stint_started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_seen_feed TEXT NOT NULL,
  reposts INTEGER NOT NULL,
  previous_started_at INTEGER,
  previous_ended_at INTEGER,
  PRIMARY KEY (company_slug, fingerprint)
);

CREATE INDEX intel_history_first_seen ON intel_history (first_seen_at);

INSERT INTO intel_history (company_slug, fingerprint, company, first_seen_at, stint_started_at, last_seen_at, last_seen_feed, reposts)
WITH licensed AS (
  SELECT company_slug, fingerprint, company, feed, first_seen_at, last_seen_at
  FROM jobs
  WHERE source NOT IN ('HackerNews', 'Remotive')
),
latest AS (
  SELECT company_slug, fingerprint, MIN(first_seen_at) AS first_seen_at, MAX(last_seen_at) AS last_seen_at
  FROM licensed
  GROUP BY company_slug, fingerprint
)
SELECT latest.company_slug, latest.fingerprint,
  (SELECT MIN(licensed.company) FROM licensed WHERE licensed.company_slug = latest.company_slug AND licensed.fingerprint = latest.fingerprint AND licensed.last_seen_at = latest.last_seen_at),
  latest.first_seen_at, latest.first_seen_at, latest.last_seen_at,
  (SELECT MIN(licensed.feed) FROM licensed WHERE licensed.company_slug = latest.company_slug AND licensed.fingerprint = latest.fingerprint AND licensed.last_seen_at = latest.last_seen_at),
  0
FROM latest;
