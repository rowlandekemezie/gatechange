import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  arrivedLongOpen,
  DAY_MILLIS,
  listingStatus,
  ListingStatus,
} from "../src/index.js";

const Offset = Schema.Int.check(
  Schema.isBetween({ maximum: 60 * DAY_MILLIS, minimum: 0 })
);

const offsets = Arbitrary.schema(
  Schema.Struct({
    departedAfter: Schema.NullOr(Offset),
    firstSeenAfter: Offset,
    laterBy: Offset,
    postedAt: Offset,
    viewedAfter: Offset,
  })
);

const journey = ListingStatus.literals;

describe("listingStatus", () => {
  it("a long-open role first seen today is not new", () => {
    const firstSeenAt = 200 * DAY_MILLIS;

    expect(
      listingStatus(
        {
          departedAt: null,
          firstSeenAt,
          postedAt: firstSeenAt - 31 * DAY_MILLIS,
        },
        firstSeenAt
      )
    ).toBe("on_time");
    expect(
      listingStatus(
        {
          departedAt: null,
          firstSeenAt,
          postedAt: firstSeenAt - 30 * DAY_MILLIS,
        },
        firstSeenAt
      )
    ).toBe("new");
  });

  it.effect.prop(
    "a departed listing reads departed, and a live one never does",
    { at: offsets },
    ({ at }) =>
      Effect.sync(() => {
        const firstSeenAt = at.postedAt + at.firstSeenAfter;

        const departedAt =
          at.departedAfter === null ? null : firstSeenAt + at.departedAfter;

        const status = listingStatus(
          { departedAt, firstSeenAt, postedAt: at.postedAt },
          firstSeenAt + at.viewedAfter
        );

        expect(status === "departed").toBe(departedAt !== null);
      })
  );

  it.effect.prop(
    "a live listing is new exactly in its first day and only moves forward through boarding to on time",
    { at: offsets },
    ({ at }) =>
      Effect.sync(() => {
        const lifecycle = {
          departedAt: null,
          firstSeenAt: at.postedAt + at.firstSeenAfter,
          postedAt: at.postedAt,
        };

        const now = lifecycle.firstSeenAt + at.viewedAfter;
        const earlier = listingStatus(lifecycle, now);
        const later = listingStatus(lifecycle, now + at.laterBy);

        expect(earlier === "new").toBe(
          at.viewedAfter < DAY_MILLIS && !arrivedLongOpen(lifecycle)
        );
        expect(journey.indexOf(later)).toBeGreaterThanOrEqual(
          journey.indexOf(earlier)
        );
      })
  );
});
