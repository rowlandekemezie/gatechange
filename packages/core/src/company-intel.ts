import { Array, Option, Order, pipe, Schema } from "effect";

import { WEEK_MILLIS } from "./alerts.js";
import { paidFeaturesAllowed } from "./entitlement.js";
import { daysOpen } from "./job-store.js";
import { Currency, EpochMillis, RoleLevel, SourceName } from "./job.js";
import type {
  CurrencyValue,
  RoleLevelValue,
  SalaryBandValue,
  SourceNameValue,
} from "./job.js";
import { SourceTerms } from "./source-terms.js";
import type { SourceTermsValue } from "./source-terms.js";

export const TREND_WEEKS = 13;

export const MIN_TREND_ROLES = 3;

export const MIN_TREND_WEEKS = 4;

export const TREND_WINDOW_MILLIS = TREND_WEEKS * WEEK_MILLIS;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const CompanySlug = Schema.String.check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
);

export const companySlugOf = (company: string): Option.Option<string> =>
  Option.liftPredicate(
    company
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word.length > 0)
      .join("-"),
    (slug) => slug.length > 0
  );

export const historyRangeOf = (slug: string) => {
  const key = slug.replaceAll("-", "");

  return { from: `${key}|`, until: `${key}}` };
};

export const sourceOfFeedKey = (feed: string): Option.Option<SourceNameValue> =>
  Array.findFirst(SourceName.literals, (source) =>
    feed.startsWith(`${source.toLowerCase()}:`)
  );

export interface OpenRoleRecord {
  readonly company: string;
  readonly id: string;
  readonly openedAt: number;
  readonly reposts: number;
  readonly role: RoleLevelValue;
  readonly salary: SalaryBandValue | null;
  readonly source: SourceNameValue;
  readonly title: string;
}

export interface HistoryRecord {
  readonly feed: string;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface CompanyRecords {
  readonly history: readonly HistoryRecord[];
  readonly open: readonly OpenRoleRecord[];
  readonly trackedSince: number | null;
}

export const CompanySummary = Schema.Struct({
  longestOpenDays: Count,
  openRoles: Count,
});

export type CompanySummaryValue = typeof CompanySummary.Type;

export const companySummaryOf = (
  jobs: readonly { readonly daysOpen: number }[]
): CompanySummaryValue => ({
  longestOpenDays: Math.max(0, ...jobs.map((job) => job.daysOpen)),
  openRoles: jobs.length,
});

export const IntelRole = Schema.Struct({
  daysOpen: Count,
  id: Schema.NonEmptyString,
  reposts: Count,
  role: RoleLevel,
  title: Schema.NonEmptyString,
});

export type IntelRoleValue = typeof IntelRole.Type;

export const TrendWeek = Schema.Struct({
  open: Count,
  weekEnding: EpochMillis,
});

export type TrendWeekValue = typeof TrendWeek.Type;

export const ShownTrend = Schema.TaggedStruct("Shown", {
  weeks: Schema.Array(TrendWeek),
});

export const ThinTrend = Schema.TaggedStruct("Thin", {
  roles: Count,
  weeks: Count,
});

export const HiringTrend = Schema.Union([ShownTrend, ThinTrend]);

export type HiringTrendValue = typeof HiringTrend.Type;

export const TypicalBand = Schema.Struct({
  currency: Currency,
  max: Count,
  min: Count,
  roles: Count,
});

export type TypicalBandValue = typeof TypicalBand.Type;

export const CompanyIntel = Schema.Struct({
  bands: Schema.Array(TypicalBand),
  roles: Schema.Array(IntelRole),
  trackedSince: Schema.NullOr(EpochMillis),
  trend: HiringTrend,
});

export type CompanyIntelValue = typeof CompanyIntel.Type;

const typicalAmount = (amounts: Array.NonEmptyReadonlyArray<number>) => {
  const sorted = Array.sort(amounts, Order.Number);
  const lower = Array.getUnsafe(sorted, Math.floor((sorted.length - 1) / 2));
  const upper = Array.getUnsafe(sorted, Math.floor(sorted.length / 2));

  return Math.round((lower + upper) / 2000) * 1000;
};

const byMostRoles = Order.combine(
  Order.mapInput(
    Order.flip(Order.Number),
    (band: TypicalBandValue) => band.roles
  ),
  Order.mapInput(Order.String, (band: TypicalBandValue) => band.currency)
);

const bandsOf = (
  open: readonly OpenRoleRecord[]
): readonly TypicalBandValue[] => {
  const stated = open.flatMap((record) =>
    record.salary === null ? [] : [record.salary]
  );

  return pipe(
    Currency.literals,
    Array.flatMap((currency: CurrencyValue) => {
      const bands = stated.filter((band) => band.currency === currency);

      return Array.isReadonlyArrayNonEmpty(bands)
        ? [
            {
              currency,
              max: typicalAmount(
                pipe(
                  bands,
                  Array.map((band) => band.max)
                )
              ),
              min: typicalAmount(
                pipe(
                  bands,
                  Array.map((band) => band.min)
                )
              ),
              roles: bands.length,
            },
          ]
        : [];
    })
  ).toSorted(byMostRoles);
};

const coveredWeeks = (trackedSince: number | null, now: number) =>
  trackedSince === null
    ? 0
    : Math.min(
        TREND_WEEKS,
        Math.max(0, Math.floor((now - trackedSince) / WEEK_MILLIS))
      );

const trendOf = (
  history: readonly HistoryRecord[],
  trackedSince: number | null,
  now: number
): HiringTrendValue => {
  const weeks = coveredWeeks(trackedSince, now);

  if (history.length < MIN_TREND_ROLES || weeks < MIN_TREND_WEEKS) {
    return ThinTrend.make({ roles: history.length, weeks });
  }

  return ShownTrend.make({
    weeks: Array.makeBy(weeks, (index) => {
      const weekEnding = now - (weeks - 1 - index) * WEEK_MILLIS;
      const weekStart = weekEnding - WEEK_MILLIS;

      return {
        open: history.filter(
          (record) =>
            record.firstSeenAt <= weekEnding && record.lastSeenAt > weekStart
        ).length,
        weekEnding,
      };
    }),
  });
};

const byLongestOpen = Order.combine(
  Order.mapInput(
    Order.flip(Order.Number),
    (role: IntelRoleValue) => role.daysOpen
  ),
  Order.mapInput(Order.String, (role: IntelRoleValue) => role.title)
);

export const companyIntelOf = (
  slug: string,
  records: CompanyRecords,
  now: number,
  terms: Readonly<Record<SourceNameValue, SourceTermsValue>> = SourceTerms
): CompanyIntelValue => {
  const allowed = (source: SourceNameValue) =>
    paidFeaturesAllowed(source, terms);

  const open = records.open.filter(
    (record) =>
      allowed(record.source) &&
      Option.contains(companySlugOf(record.company), slug)
  );

  const history = records.history.filter(
    (record) =>
      record.lastSeenAt > now - TREND_WINDOW_MILLIS &&
      Option.exists(sourceOfFeedKey(record.feed), allowed)
  );

  return {
    bands: bandsOf(open),
    roles: open
      .map((record) => ({
        daysOpen: daysOpen(record.openedAt, now),
        id: record.id,
        reposts: record.reposts,
        role: record.role,
        title: record.title,
      }))
      .toSorted(byLongestOpen),
    trackedSince: records.trackedSince,
    trend: trendOf(history, records.trackedSince, now),
  };
};
