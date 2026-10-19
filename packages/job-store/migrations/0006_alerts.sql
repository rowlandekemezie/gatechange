CREATE TABLE saved_searches (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  roles TEXT NOT NULL,
  regions TEXT NOT NULL,
  search TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('Weekly')),
  created_at INTEGER NOT NULL
);

CREATE INDEX saved_searches_account_idx ON saved_searches (account_id, created_at);

CREATE TABLE alert_sends (
  account_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  period_start INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Claimed', 'Sent')),
  claimed_at INTEGER NOT NULL,
  sent_at INTEGER,
  jobs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, period_start)
);

CREATE INDEX alert_sends_claimed_idx ON alert_sends (claimed_at);

CREATE TABLE alert_unsubscribes (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  unsubscribed_at INTEGER NOT NULL
);
