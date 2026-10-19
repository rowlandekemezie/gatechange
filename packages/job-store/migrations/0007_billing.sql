CREATE TABLE billing_customers (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  customer_id TEXT NOT NULL UNIQUE,
  linked_at INTEGER NOT NULL
);

CREATE TABLE subscriptions (
  subscription_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('Monthly', 'Quarterly', 'Yearly')),
  status TEXT NOT NULL,
  period_end INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL CHECK (cancel_at_period_end IN (0, 1)),
  event_created INTEGER NOT NULL,
  event_rank INTEGER NOT NULL,
  event_id TEXT NOT NULL
);

CREATE INDEX subscriptions_account_idx ON subscriptions (account_id);

CREATE TABLE instant_alerts (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  enabled_at INTEGER NOT NULL
);

CREATE TABLE instant_sends (
  account_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  window_start INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Claimed', 'Sent')),
  claimed_at INTEGER NOT NULL,
  sent_at INTEGER,
  jobs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, window_start)
);

CREATE INDEX instant_sends_claimed_idx ON instant_sends (claimed_at);
