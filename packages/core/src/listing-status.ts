import type { FeedCoverageValue } from "./feed.js";
import { MAX_AGE_DAYS } from "./job.js";
import type { ListingStatusValue } from "./job.js";
import { DAY_MILLIS } from "./posting.js";

export const NEW_WINDOW_MILLIS = DAY_MILLIS;

export const BOARDING_WINDOW_MILLIS = 7 * DAY_MILLIS;

export const DEPARTED_RETENTION_MILLIS = DAY_MILLIS;

export const UNSEEN_RETENTION_MILLIS = MAX_AGE_DAYS * DAY_MILLIS;

export const WINDOW_HOLD_MILLIS = 30 * DAY_MILLIS;

export const EVERY_POSTING = Number.MAX_SAFE_INTEGER;

const absentRowsDepartPostedBefore: Readonly<
  Record<FeedCoverageValue, (now: number) => number>
> = {
  Complete: () => EVERY_POSTING,
  Window: (now) => now - WINDOW_HOLD_MILLIS,
};

export const departureCutoff = (coverage: FeedCoverageValue, now: number) =>
  absentRowsDepartPostedBefore[coverage](now);

export interface Lifecycle {
  readonly departedAt: number | null;
  readonly firstSeenAt: number;
  readonly postedAt: number;
}

export const listingStatus = (
  { departedAt, firstSeenAt, postedAt }: Lifecycle,
  now: number
): ListingStatusValue => {
  if (departedAt !== null) {
    return "departed";
  }

  if (now - firstSeenAt < NEW_WINDOW_MILLIS) {
    return "new";
  }

  return now - postedAt < BOARDING_WINDOW_MILLIS ? "boarding" : "on_time";
};

export interface Retention {
  readonly departedBefore: number;
  readonly unseenBefore: number;
}

export const retentionAt = (now: number): Retention => ({
  departedBefore: now - DEPARTED_RETENTION_MILLIS,
  unseenBefore: now - UNSEEN_RETENTION_MILLIS,
});
