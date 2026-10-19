import { Account, AgentToken, AgentTokenStore } from "@rat-stack/core";
import { Array, Effect, Layer } from "effect";

import { SqlExecutor, statement } from "./sql-executor.js";

export const makeAgentTokenStore = Effect.gen(function* makeAgentTokenStore() {
  const sql = yield* SqlExecutor;

  return AgentTokenStore.of({
    holderOf: (secretHash) =>
      sql
        .all(
          "agentTokenHolder",
          statement(
            `SELECT "user".id, "user".email, "user".name FROM agent_tokens
JOIN "user" ON "user".id = agent_tokens.account_id
WHERE agent_tokens.secret_hash = ?`,
            [secretHash]
          ),
          Account
        )
        .pipe(Effect.map(Array.head)),

    issue: (owner, token, secretHash, limit) =>
      sql
        .batch("issueAgentToken", [
          statement(
            `INSERT INTO agent_tokens (id, account_id, label, secret_hash, created_at)
SELECT ?, id, ?, ?, ? FROM "user"
WHERE id = ? AND (SELECT COUNT(*) FROM agent_tokens WHERE account_id = ?) < ?`,
            [
              token.id,
              token.label,
              secretHash,
              token.createdAt,
              owner,
              owner,
              limit,
            ]
          ),
        ])
        .pipe(Effect.map(([inserted]) => inserted?.changes === 1)),

    revoke: (owner, id) =>
      sql
        .batch("revokeAgentToken", [
          statement(
            "DELETE FROM agent_tokens WHERE account_id = ? AND id = ?",
            [owner, id]
          ),
        ])
        .pipe(Effect.asVoid),

    tokensOf: (owner) =>
      sql.all(
        "agentTokens",
        statement(
          "SELECT id, label, created_at AS createdAt FROM agent_tokens WHERE account_id = ? ORDER BY created_at DESC, id ASC",
          [owner]
        ),
        AgentToken
      ),
  });
});

export const agentTokenStoreLayer = Layer.effect(
  AgentTokenStore,
  makeAgentTokenStore
);
