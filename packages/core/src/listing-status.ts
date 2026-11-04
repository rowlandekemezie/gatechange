import type { FeedCoverageValue } from "./feed.js";
import { ADMISSION_DAYS } from "./job.js";
import type { ListingStatusValue } from "./job.js";
import { DAY_MILLIS } from "./posting.js";

export const NEW_WINDOW_MILLIS = DAY_MILLIS;

export const BOARDING_WINDOW_MILLIS = 7 * DAY_MILLIS;

export const DEPARTED_RETENTION_MILLIS = DAY_MILLIS;

const ADMISSION_MILLIS = ADMISSION_DAYS * DAY_MILLIS;

export const UNSEEN_RETENTION_MILLIS = ADMISSION_MILLIS;

export const WINDOW_HOLD_MILLIS = ADMISSION_MILLIS;

export const EVERY_POSTING = Number.MAX_SAFE_INTEGER;

interface Sighting {
  readonly lastSeenAt: number;
  readonly postedAt: number;
}

export interface CoverageRule {
  readonly admitsLongOpen: boolean;
  readonly departPostedBefore: (now: number) => number;
  readonly validThrough: (sighting: Sighting) => number;
}

export const coverageRules: Readonly<Record<FeedCoverageValue, CoverageRule>> =
  {
    Complete: {
      admitsLongOpen: true,
      departPostedBefore: () => EVERY_POSTING,
      validThrough: ({ lastSeenAt }) => lastSeenAt + ADMISSION_MILLIS,
    },
    Window: {
      admitsLongOpen: false,
      departPostedBefore: (now) => now - WINDOW_HOLD_MILLIS,
      validThrough: ({ lastSeenAt, postedAt }) =>
        Math.max(postedAt + WINDOW_HOLD_MILLIS, lastSeenAt),
    },
  };

export const arrivedLongOpen = ({
  firstSeenAt,
  postedAt,
}: Pick<Lifecycle, "firstSeenAt" | "postedAt">) =>
  firstSeenAt - postedAt > ADMISSION_MILLIS;

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

  if (
    now - firstSeenAt < NEW_WINDOW_MILLIS &&
    !arrivedLongOpen({ firstSeenAt, postedAt })
  ) {
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
