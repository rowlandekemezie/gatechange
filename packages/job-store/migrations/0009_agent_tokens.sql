CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  label TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE INDEX agent_tokens_account_idx ON agent_tokens (account_id, created_at);
