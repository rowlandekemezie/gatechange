CREATE TABLE subscriptions_next (
  subscription_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (length(plan) BETWEEN 1 AND 32),
  status TEXT NOT NULL,
  period_end INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL CHECK (cancel_at_period_end IN (0, 1)),
  event_created INTEGER NOT NULL,
  event_rank INTEGER NOT NULL,
  event_id TEXT NOT NULL
);

INSERT INTO subscriptions_next
SELECT subscription_id, account_id, plan, status, period_end, cancel_at_period_end, event_created, event_rank, event_id
FROM subscriptions;

DROP TABLE subscriptions;

ALTER TABLE subscriptions_next RENAME TO subscriptions;

CREATE INDEX subscriptions_account_idx ON subscriptions (account_id);
