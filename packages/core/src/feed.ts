import { Array, Option, Order, pipe, Schema } from "effect";

import { EpochMillis, SourceName } from "./job.js";
import type { SourceNameValue } from "./job.js";

export interface FeedRef {
  readonly company: Option.Option<string>;
  readonly key: string;
  readonly minIntervalMinutes: number;
  readonly source: SourceNameValue;
}

export const FeedState = Schema.Struct({
  consecutiveFailures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  key: Schema.NonEmptyString,
  lastAttemptAt: Schema.NullOr(EpochMillis),
  lastError: Schema.NullOr(Schema.String),
  lastSuccessAt: Schema.NullOr(EpochMillis),
});

export type FeedStateValue = typeof FeedState.Type;

export const FeedOutcome = Schema.Struct({
  departed: Schema.Int,
  error: Schema.NullOr(Schema.String),
  key: Schema.String,
  source: SourceName,
  upserted: Schema.Int,
});

export type FeedOutcomeValue = typeof FeedOutcome.Type;

export const INGEST_INTERVAL_MINUTES = 20;

export const DEFAULT_FEEDS_PER_RUN = 20;

export const MAX_BACKOFF_DOUBLINGS = 4;

const MINUTE_MILLIS = 60_000;

export const backoffMinutes = (
  feed: FeedRef,
  state: Option.Option<FeedStateValue>
) =>
  feed.minIntervalMinutes *
  2 **
    Math.min(
      Option.match(state, {
        onNone: () => 0,
        onSome: (found) => found.consecutiveFailures,
      }),
      MAX_BACKOFF_DOUBLINGS
    );

export const isFeedDue = (
  feed: FeedRef,
  state: Option.Option<FeedStateValue>,
  now: number
) =>
  Option.match(
    pipe(
      state,
      Option.flatMap((found) => Option.fromNullishOr(found.lastAttemptAt))
    ),
    {
      onNone: () => true,
      onSome: (lastAttemptAt) =>
        now - lastAttemptAt >= backoffMinutes(feed, state) * MINUTE_MILLIS,
    }
  );

const lastAttemptOrder = Order.mapInput(
  Order.Number,
  ([, state]: readonly [FeedRef, Option.Option<FeedStateValue>]) =>
    Option.match(
      pipe(
        state,
        Option.flatMap((found) => Option.fromNullishOr(found.lastAttemptAt))
      ),
      { onNone: () => -1, onSome: (lastAttemptAt) => lastAttemptAt }
    )
);

export const selectDueFeeds = (
  catalog: readonly FeedRef[],
  states: readonly FeedStateValue[],
  now: number,
  limit: number
): readonly FeedRef[] =>
  pipe(
    catalog,
    Array.map(
      (feed) =>
        [
          feed,
          Array.findFirst(states, (state) => state.key === feed.key),
        ] as const
    ),
    Array.filter(([feed, state]) => isFeedDue(feed, state, now)),
    (entries) => entries.toSorted(lastAttemptOrder),
    Array.take(Math.max(0, limit)),
    Array.map(([feed]) => feed)
  );
