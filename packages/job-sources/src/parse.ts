import type { ArrangementValue } from "@rat-stack/core";
import { DateTime, Match, Option, Predicate, pipe } from "effect";

const SECONDS_THRESHOLD = 100_000_000_000;

export const epochMillisOf = (
  value: number | string | null | undefined
): number | null => {
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
    pipe(
      DateTime.make(trimmed),
      Option.map((parsed) => DateTime.toEpochMillis(parsed))
    )
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
  const low =
    minimum !== null && minimum !== undefined && minimum > 0 ? minimum : null;

  const high =
    maximum !== null && maximum !== undefined && maximum > 0 ? maximum : null;

  if (low === null && high === null) {
    return null;
  }

  const unit =
    currency === null || currency === undefined || currency.length === 0
      ? ""
      : ` ${currency.toUpperCase()}`;

  const interval =
    period === null || period === undefined || period.length === 0
      ? ""
      : ` / ${period.toLowerCase()}`;

  if (low !== null && high !== null && low !== high) {
    return `${compactAmount(low)}–${compactAmount(high)}${unit}${interval}`;
  }

  return `${compactAmount(low ?? high ?? 0)}${unit}${interval}`;
};

export const workplaceOf = (
  value: string | null | undefined
): ArrangementValue =>
  Match.value((value ?? "").toLowerCase().replaceAll(/[\s_-]/gu, "")).pipe(
    Match.withReturnType<ArrangementValue>(),
    Match.when("remote", () => "Remote"),
    Match.when("hybrid", () => "Hybrid"),
    Match.whenOr("onsite", "inoffice", "inperson", () => "Onsite"),
    Match.orElse(() => "Unspecified")
  );

export const periodOf = (value: string | null | undefined): string | null =>
  Option.getOrNull(
    Option.fromNullishOr(
      /\b(?<period>year|month|week|day|hour)/iu.exec(value ?? "")?.groups
        ?.period
    )
  );

const entities: readonly (readonly [RegExp, string])[] = [
  [/&quot;/gu, '"'],
  [/&gt;/gu, ">"],
  [/&lt;/gu, "<"],
  [/&nbsp;/gu, " "],
  [/&mdash;/gu, "—"],
  [/&ndash;/gu, "–"],
  [/&minus;/gu, "-"],
  [/&euro;/gu, "€"],
  [/&pound;/gu, "£"],
  [/&yen;/gu, "¥"],
  [/&rsquo;/gu, "’"],
  [/&lsquo;/gu, "‘"],
  [/&rdquo;/gu, "”"],
  [/&ldquo;/gu, "“"],
  [/&hellip;/gu, "…"],
  [/&bull;/gu, "•"],
  [/&amp;/gu, "&"],
];

const characterOf = (entity: string, code: number) =>
  code <= 0x10_ff_ff ? String.fromCodePoint(code) : entity;

const blockTag =
  /<\/?(?:p|div|li|ul|ol|br|h[1-6]|tr|table|section|article|blockquote|hr)\b[^>]*>/giu;

const htmlTag = /<(?<closing>\/?)(?<name>[a-z][\w-]*)\b[^>]*>/giu;

const hiddenByMarkup =
  /\shidden(?:[\s=/>]|$)|\sstyle\s*=\s*["'][^"']*\b(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu;

const unreadTags: ReadonlySet<string> = new Set([
  "noscript",
  "script",
  "style",
  "template",
]);

const voidTags: ReadonlySet<string> = new Set([
  "area",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const opensHiddenElement = (tag: string, name: string) =>
  !voidTags.has(name) &&
  !tag.endsWith("/>") &&
  (unreadTags.has(name) || hiddenByMarkup.test(tag));

export const withoutHiddenElements = (html: string): string => {
  const shown: string[] = [];
  let shownFrom = 0;
  let hidden: { depth: number; name: string } | null = null;

  for (const tag of html.matchAll(htmlTag)) {
    const name = (tag.groups?.name ?? "").toLowerCase();
    const closing = tag.groups?.closing === "/";

    if (hidden === null) {
      if (!closing && opensHiddenElement(tag[0], name)) {
        shown.push(html.slice(shownFrom, tag.index));
        hidden = { depth: 1, name };
      }
    } else if (name === hidden.name) {
      hidden.depth += closing ? -1 : 1;

      if (hidden.depth === 0) {
        shownFrom = tag.index + tag[0].length;
        hidden = null;
      }
    }
  }

  if (hidden === null) {
    shown.push(html.slice(shownFrom));
  }

  return shown.join(" ");
};

export const linesOfHtml = (html: string): string => {
  let text = withoutHiddenElements(html)
    .replaceAll(/\s+/gu, " ")
    .replaceAll(blockTag, "\n")
    .replaceAll(/<[^>]*>/gu, " ")
    .replaceAll(/&#x(?<hex>[\da-f]+);/giu, (entity, hex: string) =>
      characterOf(entity, Number.parseInt(hex, 16))
    )
    .replaceAll(/&#(?<decimal>\d+);/gu, (entity, decimal: string) =>
      characterOf(entity, Number(decimal))
    );

  for (const [pattern, replacement] of entities) {
    text = text.replaceAll(pattern, replacement);
  }

  return text
    .split("\n")
    .map((line) => line.replaceAll(/\s+/gu, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
};

export const textOfHtml = (html: string): string =>
  linesOfHtml(html).replaceAll(/\s+/gu, " ").trim();

export const nonEmpty = (
  values: readonly (string | null | undefined)[]
): readonly string[] => {
  const kept: string[] = [];

  for (const value of values) {
    const trimmed = value?.trim() ?? "";

    if (trimmed.length > 0 && !kept.includes(trimmed)) {
      kept.push(trimmed);
    }
  }

  return kept;
};
