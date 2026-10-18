import {
  AccountId,
  AlertStore,
  DigestFrequency,
  RECIPIENT_SENDS_PER_WEEK,
  Region,
  regions,
  RoleLevel,
  roleLevels,
  SavedSearchId,
  WEEK_MILLIS,
} from "@rat-stack/core";
import type {
  AccountIdValue,
  DigestRecipient,
  SavedSearchValue,
  SearchFiltersValue,
} from "@rat-stack/core";
import { Array, Effect, Layer, Option, pipe, Schema } from "effect";

import { jobColumns } from "./queries.js";
import { SqlExecutor, statement } from "./sql-executor.js";
import { JobRow, jobOfRow } from "./store.js";

const searchColumns =
  "id, account_id, roles, regions, search, frequency, created_at";

const SearchRow = Schema.Struct({
  account_id: AccountId,
  created_at: Schema.Finite,
  frequency: DigestFrequency,
  id: SavedSearchId,
  regions: Schema.fromJsonString(Schema.NonEmptyArray(Region)),
  roles: Schema.fromJsonString(Schema.NonEmptyArray(RoleLevel)),
  search: Schema.String,
});

const RecipientRow = Schema.Struct({
  ...SearchRow.fields,
  email: Schema.String,
  last_sent_at: Schema.NullOr(Schema.Finite),
});

const TotalRow = Schema.Struct({ total: Schema.Finite });

const searchOfRow = (row: typeof SearchRow.Type): SavedSearchValue => ({
  createdAt: row.created_at,
  filters: { regions: row.regions, roles: row.roles, search: row.search },
  frequency: row.frequency,
  id: row.id,
  owner: row.account_id,
});

const inOrderOf = <A>(universe: readonly A[], values: readonly A[]) =>
  universe.filter((candidate) => values.includes(candidate));

const canonical = (filters: SearchFiltersValue) => ({
  regions: JSON.stringify(inOrderOf(regions, filters.regions)),
  roles: JSON.stringify(inOrderOf(roleLevels, filters.roles)),
  search: filters.search.trim(),
});

const recipientsOf = (
  rows: readonly (typeof RecipientRow.Type)[],
  now: number
): readonly DigestRecipient[] =>
  pipe(
    Array.isReadonlyArrayNonEmpty(rows)
      ? Array.groupWith(
          rows,
          (left, right) => left.account_id === right.account_id
        )
      : [],
    Array.map(([first, ...rest]): DigestRecipient => ({
      account: first.account_id,
      email: first.email,
      searches: [first, ...rest].map(searchOfRow),
      since: first.last_sent_at ?? now - WEEK_MILLIS,
    }))
  );

export const makeAlertStore = Effect.gen(function* makeAlertStore() {
  const sql = yield* SqlExecutor;

  const searchesOf = (owner: AccountIdValue) =>
    sql
      .all(
        "searchesOf",
        statement(
          `SELECT ${searchColumns} FROM saved_searches WHERE account_id = ? ORDER BY created_at DESC, id`,
          [owner]
        ),
        SearchRow
      )
      .pipe(Effect.map(Array.map(searchOfRow)));

  return AlertStore.of({
    claimDigest: (account, periodStart, now) =>
      sql
        .batch("claimDigest", [
          statement(
            `INSERT INTO alert_sends (account_id, period_start, status, claimed_at)
SELECT ?, ?, 'Claimed', ?
WHERE (SELECT COUNT(*) FROM alert_sends WHERE account_id = ? AND claimed_at > ?) < ?
ON CONFLICT (account_id, period_start) DO NOTHING`,
            [
              account,
              periodStart,
              now,
              account,
              now - WEEK_MILLIS,
              RECIPIENT_SENDS_PER_WEEK,
            ]
          ),
        ])
        .pipe(Effect.map(([claim]) => claim?.changes === 1)),

    deleteSearch: (owner, id) =>
      sql
        .batch("deleteSearch", [
          statement(
            "DELETE FROM saved_searches WHERE id = ? AND account_id = ?",
            [id, owner]
          ),
        ])
        .pipe(Effect.asVoid),

    dueRecipients: (periodStart, now) =>
      sql
        .all(
          "dueRecipients",
          statement(
            `SELECT s.id, s.account_id, s.roles, s.regions, s.search, s.frequency, s.created_at, u.email,
  (SELECT MAX(a.sent_at) FROM alert_sends AS a WHERE a.account_id = s.account_id AND a.status = 'Sent') AS last_sent_at
FROM saved_searches AS s JOIN "user" AS u ON u.id = s.account_id
WHERE u.emailVerified = 1
  AND NOT EXISTS (SELECT 1 FROM alert_unsubscribes AS x WHERE x.account_id = s.account_id)
  AND NOT EXISTS (SELECT 1 FROM alert_sends AS a WHERE a.account_id = s.account_id AND a.period_start = ?)
ORDER BY s.account_id, s.created_at`,
            [periodStart]
          ),
          RecipientRow
        )
        .pipe(Effect.map((rows) => recipientsOf(rows, now))),

    jobsSeenSince: (since) =>
      sql
        .all(
          "jobsSeenSince",
          statement(`SELECT ${jobColumns} FROM jobs WHERE first_seen_at >= ?`, [
            since,
          ]),
          JobRow
        )
        .pipe(Effect.map(Array.map(jobOfRow))),

    markSent: (account, periodStart, sentAt, jobs) =>
      sql
        .batch("markSent", [
          statement(
            "UPDATE alert_sends SET status = 'Sent', sent_at = ?, jobs = ? WHERE account_id = ? AND period_start = ?",
            [sentAt, jobs, account, periodStart]
          ),
        ])
        .pipe(Effect.asVoid),

    releaseDigest: (account, periodStart) =>
      sql
        .batch("releaseDigest", [
          statement(
            "DELETE FROM alert_sends WHERE account_id = ? AND period_start = ? AND status = 'Claimed'",
            [account, periodStart]
          ),
        ])
        .pipe(Effect.asVoid),

    saveSearch: (owner, filters, createdAt, limit) =>
      Effect.gen(function* saveSearch() {
        const row = canonical(filters);

        const saved = yield* sql.all(
          "saveSearch",
          statement(
            `INSERT INTO saved_searches (${searchColumns})
SELECT lower(hex(randomblob(16))), ?, ?, ?, ?, 'Weekly', ?
WHERE (SELECT COUNT(*) FROM saved_searches WHERE account_id = ?) < ?
  AND NOT EXISTS (SELECT 1 FROM saved_searches WHERE account_id = ? AND roles = ? AND regions = ? AND search = ?)
RETURNING ${searchColumns}`,
            [
              owner,
              row.roles,
              row.regions,
              row.search,
              createdAt,
              owner,
              limit,
              owner,
              row.roles,
              row.regions,
              row.search,
            ]
          ),
          SearchRow
        );

        const found = Option.isSome(Array.head(saved))
          ? saved
          : yield* sql.all(
              "findSearch",
              statement(
                `SELECT ${searchColumns} FROM saved_searches WHERE account_id = ? AND roles = ? AND regions = ? AND search = ?`,
                [owner, row.roles, row.regions, row.search]
              ),
              SearchRow
            );

        yield* sql.batch("resubscribe", [
          statement("DELETE FROM alert_unsubscribes WHERE account_id = ?", [
            owner,
          ]),
        ]);

        return Option.map(Array.head(found), searchOfRow);
      }),

    searchesOf,

    sendsSince: (since) =>
      sql
        .all(
          "sendsSince",
          statement(
            "SELECT COUNT(*) AS total FROM alert_sends WHERE claimed_at >= ?",
            [since]
          ),
          TotalRow
        )
        .pipe(
          Effect.map((rows) =>
            Option.match(Array.head(rows), {
              onNone: () => 0,
              onSome: (row) => row.total,
            })
          )
        ),

    unsubscribe: (account, at) =>
      sql
        .batch("unsubscribe", [
          statement(
            `INSERT INTO alert_unsubscribes (account_id, unsubscribed_at)
SELECT id, ? FROM "user" WHERE id = ?
ON CONFLICT (account_id) DO NOTHING`,
            [at, account]
          ),
        ])
        .pipe(Effect.asVoid),
  });
});

export const alertStoreLayer = Layer.effect(AlertStore, makeAlertStore);
