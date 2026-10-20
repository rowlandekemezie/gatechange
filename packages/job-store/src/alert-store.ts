import {
  AccountId,
  AlertStore,
  DAY_MILLIS,
  DigestFrequency,
  GRANTING_STATUSES,
  INSTANT_SENDS_PER_MEMBER_PER_DAY,
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

import { jobColumns, placeholders } from "./queries.js";
import { SqlExecutor, statement } from "./sql-executor.js";
import { JobRow, jobOfRow } from "./store.js";

const sends = {
  Instant: { period: "window_start", table: "instant_sends" },
  Weekly: { period: "period_start", table: "alert_sends" },
} as const;

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
    claimDigest: (cadence, account, periodStart, now, dailyLimit) =>
      sql
        .batch("claimDigest", [
          cadence === "Instant"
            ? statement(
                `INSERT INTO instant_sends (account_id, window_start, status, claimed_at)
SELECT ?, ?, 'Claimed', ?
WHERE (SELECT COUNT(*) FROM instant_sends WHERE claimed_at >= ?) < ?
  AND (SELECT COUNT(*) FROM instant_sends WHERE account_id = ? AND claimed_at > ?) < ?
ON CONFLICT (account_id, window_start) DO NOTHING`,
                [
                  account,
                  periodStart,
                  now,
                  now - DAY_MILLIS,
                  dailyLimit,
                  account,
                  now - DAY_MILLIS,
                  INSTANT_SENDS_PER_MEMBER_PER_DAY,
                ]
              )
            : statement(
                `INSERT INTO alert_sends (account_id, period_start, status, claimed_at)
SELECT ?, ?, 'Claimed', ?
WHERE (SELECT COUNT(*) FROM alert_sends WHERE claimed_at >= ?) < ?
  AND (SELECT COUNT(*) FROM alert_sends WHERE account_id = ? AND claimed_at > ?) < ?
ON CONFLICT (account_id, period_start) DO NOTHING`,
                [
                  account,
                  periodStart,
                  now,
                  now - DAY_MILLIS,
                  dailyLimit,
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

    dueRecipients: (cadence, periodStart, now, account) =>
      sql
        .all(
          "dueRecipients",
          cadence === "Instant"
            ? statement(
                `SELECT s.id, s.account_id, s.roles, s.regions, s.search, s.frequency, s.created_at, u.email,
  MAX(i.enabled_at, COALESCE((SELECT MAX(COALESCE(a.sent_at, a.claimed_at)) FROM instant_sends AS a WHERE a.account_id = s.account_id), 0)) AS last_sent_at
FROM saved_searches AS s
JOIN "user" AS u ON u.id = s.account_id
JOIN instant_alerts AS i ON i.account_id = s.account_id
WHERE u.emailVerified = 1
  ${account === undefined ? "" : "AND s.account_id = ?"}
  AND NOT EXISTS (SELECT 1 FROM alert_unsubscribes AS x WHERE x.account_id = s.account_id)
  AND NOT EXISTS (SELECT 1 FROM instant_sends AS a WHERE a.account_id = s.account_id AND a.window_start = ?)
  AND (SELECT COUNT(*) FROM instant_sends AS c WHERE c.account_id = s.account_id AND c.claimed_at > ?) < ?
  AND EXISTS (SELECT 1 FROM subscriptions AS b WHERE b.account_id = s.account_id AND b.period_end > ? AND b.status IN (${placeholders(GRANTING_STATUSES.length)}))
ORDER BY s.account_id, s.created_at`,
                [
                  ...(account === undefined ? [] : [account]),
                  periodStart,
                  now - DAY_MILLIS,
                  INSTANT_SENDS_PER_MEMBER_PER_DAY,
                  now,
                  ...GRANTING_STATUSES,
                ]
              )
            : statement(
                `SELECT s.id, s.account_id, s.roles, s.regions, s.search, s.frequency, s.created_at, u.email,
  (SELECT MAX(COALESCE(a.sent_at, a.claimed_at)) FROM alert_sends AS a WHERE a.account_id = s.account_id) AS last_sent_at
FROM saved_searches AS s JOIN "user" AS u ON u.id = s.account_id
WHERE u.emailVerified = 1
  ${account === undefined ? "" : "AND s.account_id = ?"}
  AND NOT EXISTS (SELECT 1 FROM alert_unsubscribes AS x WHERE x.account_id = s.account_id)
  AND NOT EXISTS (SELECT 1 FROM alert_sends AS a WHERE a.account_id = s.account_id AND a.period_start = ?)
ORDER BY s.account_id, s.created_at`,
                [...(account === undefined ? [] : [account]), periodStart]
              ),
          RecipientRow
        )
        .pipe(Effect.map((rows) => recipientsOf(rows, now))),

    instantAlertsOf: (account) =>
      sql
        .all(
          "instantAlertsOf",
          statement(
            "SELECT COUNT(*) AS total FROM instant_alerts WHERE account_id = ?",
            [account]
          ),
          TotalRow
        )
        .pipe(Effect.map((rows) => rows.some((row) => row.total > 0))),

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

    markSent: (cadence, account, periodStart, sentAt, jobs) =>
      sql
        .batch("markSent", [
          statement(
            `UPDATE ${sends[cadence].table} SET status = 'Sent', sent_at = ?, jobs = ? WHERE account_id = ? AND ${sends[cadence].period} = ?`,
            [sentAt, jobs, account, periodStart]
          ),
        ])
        .pipe(Effect.asVoid),

    releaseDigest: (cadence, account, periodStart) =>
      sql
        .batch("releaseDigest", [
          statement(
            `DELETE FROM ${sends[cadence].table} WHERE account_id = ? AND ${sends[cadence].period} = ? AND status = 'Claimed'`,
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

    sendsSince: (cadence, since) =>
      sql
        .all(
          "sendsSince",
          statement(
            `SELECT COUNT(*) AS total FROM ${sends[cadence].table} WHERE claimed_at >= ?`,
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

    setInstantAlerts: (account, enabled, at) =>
      sql
        .batch("setInstantAlerts", [
          enabled
            ? statement(
                `INSERT INTO instant_alerts (account_id, enabled_at)
SELECT id, ? FROM "user" WHERE id = ?
ON CONFLICT (account_id) DO NOTHING`,
                [at, account]
              )
            : statement("DELETE FROM instant_alerts WHERE account_id = ?", [
                account,
              ]),
        ])
        .pipe(Effect.asVoid),

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
