import { describe, expect, it } from "@effect/vitest";
import { Array, Option, Schema, pipe } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { isFeedDue, selectDueFeeds } from "../src/index.js";
import type { FeedRef, FeedStateValue } from "../src/index.js";

const MINUTE = 60_000;

const FeedFixture = Schema.Struct({
  attemptedMinutesAgo: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ maximum: 2000, minimum: 0 }))
  ),
  failures: Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 0 })),
  intervalMinutes: Schema.Int.check(
    Schema.isBetween({ maximum: 360, minimum: 1 })
  ),
});

const fixtures = Arbitrary.array(Arbitrary.schema(FeedFixture), {
  maxLength: 40,
});

const NOW = 10_000 * MINUTE;

const build = (rows: readonly (typeof FeedFixture.Type)[]) => {
  const catalog: readonly FeedRef[] = pipe(
    rows,
    Array.map((row, index) => ({
      company: Option.none(),
      coverage: "Complete",
      key: `feed-${index}`,
      minIntervalMinutes: row.intervalMinutes,
      source: "Greenhouse",
    }))
  );

  const states: readonly FeedStateValue[] = pipe(
    rows,
    Array.map((row, index) => ({
      consecutiveFailures: row.failures,
      key: `feed-${index}`,
      lastAttemptAt:
        row.attemptedMinutesAgo === null
          ? null
          : NOW - row.attemptedMinutesAgo * MINUTE,
      lastError: null,
      lastSuccessAt: null,
    }))
  );

  return { catalog, states };
};

const stateFor = (states: readonly FeedStateValue[], feed: FeedRef) =>
  Array.findFirst(states, (state) => state.key === feed.key);

describe("feed scheduling", () => {
  it.prop(
    "a run never selects more feeds than its limit and only selects due feeds",
    {
      limit: Schema.Int.check(Schema.isBetween({ maximum: 50, minimum: 0 })),
      rows: fixtures,
    },
    ({ limit, rows }) => {
      const { catalog, states } = build(rows);
      const selected = selectDueFeeds(catalog, states, NOW, limit);

      expect(selected.length).toBeLessThanOrEqual(limit);

      for (const feed of selected) {
        expect(isFeedDue(feed, stateFor(states, feed), NOW)).toBe(true);
      }
    }
  );

  it.prop(
    "a run fills its limit whenever enough feeds are due",
    {
      limit: Schema.Int.check(Schema.isBetween({ maximum: 50, minimum: 0 })),
      rows: fixtures,
    },
    ({ limit, rows }) => {
      const { catalog, states } = build(rows);

      const due = pipe(
        catalog,
        Array.filter((feed) => isFeedDue(feed, stateFor(states, feed), NOW))
      );

      expect(selectDueFeeds(catalog, states, NOW, limit).length).toBe(
        Math.min(limit, due.length)
      );
    }
  );

  it.prop(
    "a feed that was never attempted is chosen before any feed that was",
    { rows: fixtures },
    ({ rows }) => {
      const { catalog, states } = build(rows);
      const selected = selectDueFeeds(catalog, states, NOW, catalog.length);

      const neverAttempted = (feed: FeedRef) =>
        Option.match(stateFor(states, feed), {
          onNone: () => true,
          onSome: (state) => state.lastAttemptAt === null,
        });

      const firstAttempted = Array.findFirstIndex(
        selected,
        (feed) => !neverAttempted(feed)
      );

      if (Option.isSome(firstAttempted)) {
        expect(
          pipe(
            Array.drop(selected, firstAttempted.value),
            Array.some(neverAttempted)
          )
        ).toBe(false);
      }
    }
  );

  it.prop(
    "repeated failures back a feed off rather than retrying it every run",
    {
      failures: Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 1 })),
    },
    ({ failures }) => {
      const feed: FeedRef = {
        company: Option.none(),
        coverage: "Complete",
        key: "feed",
        minIntervalMinutes: 60,
        source: "Lever",
      };

      const state: FeedStateValue = {
        consecutiveFailures: failures,
        key: "feed",
        lastAttemptAt: NOW - 61 * MINUTE,
        lastError: "boom",
        lastSuccessAt: null,
      };

      expect(isFeedDue(feed, Option.some(state), NOW)).toBe(false);
    }
  );
});
