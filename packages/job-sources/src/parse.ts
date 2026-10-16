import { DateTime, Match, Option, Predicate, pipe } from "effect";
import type { ArrangementValue } from "@rat-stack/core";

const SECONDS_THRESHOLD = 100_000_000_000;

export const epochMillisOf = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (Predicate.isNumber(value)) {
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }

    return value < SECONDS_THRESHOLD ? value * 1000 : value;
  }

  const trimmed = value.trim();

  if (/^\d+$/u.test(trimmed)) {
    return epochMillisOf(Number(trimmed));
  }

  return Option.getOrNull(
    pipe(DateTime.make(trimmed), Option.map((parsed) => DateTime.toEpochMillis(parsed)))
  );
};

const compactAmount = (amount: number) =>
  amount >= 1000 ? `${Math.round(amount / 1000)}k` : `${Math.round(amount)}`;

export const salaryRange = (
  minimum: number | null | undefined,
  maximum: number | null | undefined,
  currency: string | null | undefined,
  period: string | null | undefined
): string | null => {
  const low = minimum !== null && minimum !== undefined && minimum > 0 ? minimum : null;
  const high = maximum !== null && maximum !== undefined && maximum > 0 ? maximum : null;

  if (low === null && high === null) {
    return null;
  }

  const unit = currency === null || currency === undefined || currency.length === 0 ? "" : ` ${currency.toUpperCase()}`;
  const interval = period === null || period === undefined || period.length === 0 ? "" : ` / ${period.toLowerCase()}`;

  if (low !== null && high !== null && low !== high) {
    return `${compactAmount(low)}–${compactAmount(high)}${unit}${interval}`;
  }

  return `${compactAmount(low ?? high ?? 0)}${unit}${interval}`;
};

export const workplaceOf = (value: string | null | undefined): ArrangementValue =>
  Match.value((value ?? "").toLowerCase().replaceAll(/[\s_-]/gu, "")).pipe(
    Match.withReturnType<ArrangementValue>(),
    Match.when("remote", () => "Remote"),
    Match.when("hybrid", () => "Hybrid"),
    Match.whenOr("onsite", "inoffice", "inperson", () => "Onsite"),
    Match.orElse(() => "Unspecified")
  );

export const periodOf = (value: string | null | undefined): string | null =>
  Option.getOrNull(
    Option.fromNullishOr(/\b(?<period>year|month|week|day|hour)/iu.exec(value ?? "")?.groups?.["period"])
  );

const entities: readonly (readonly [RegExp, string])[] = [
  [/&#x2F;/gu, "/"],
  [/&#x27;/gu, "'"],
  [/&#39;/gu, "'"],
  [/&quot;/gu, '"'],
  [/&gt;/gu, ">"],
  [/&lt;/gu, "<"],
  [/&nbsp;/gu, " "],
  [/&amp;/gu, "&"],
];

export const textOfHtml = (html: string): string => {
  let text = html.replaceAll(/<[^>]*>/gu, " ");

  for (const [pattern, replacement] of entities) {
    text = text.replaceAll(pattern, replacement);
  }

  return text.replaceAll(/\s+/gu, " ").trim();
};

export const nonEmpty = (values: readonly (string | null | undefined)[]): readonly string[] => {
  const kept: string[] = [];

  for (const value of values) {
    const trimmed = value?.trim() ?? "";

    if (trimmed.length > 0 && !kept.includes(trimmed)) {
      kept.push(trimmed);
    }
  }

  return kept;
};
