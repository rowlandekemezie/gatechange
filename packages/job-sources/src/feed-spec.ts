import { Data, Match, Option } from "effect";
import type { FeedRef, SourceNameValue } from "@rat-stack/core";

export type FeedSpecValue = Data.TaggedEnum<{
  Ashby: { readonly company: string; readonly slug: string };
  Greenhouse: { readonly company: string; readonly slug: string };
  HackerNews: { readonly thread: string };
  Himalayas: { readonly query: string };
  Jobicy: { readonly tag: string };
  Lever: { readonly company: string; readonly slug: string };
  RemoteOK: { readonly listing: string };
  Remotive: { readonly search: string };
}>;

export const FeedSpec = Data.taggedEnum<FeedSpecValue>();

const slugOf = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");

export const feedKey: (spec: FeedSpecValue) => string = FeedSpec.$match({
  Ashby: ({ slug }) => `ashby:${slug}`,
  Greenhouse: ({ slug }) => `greenhouse:${slug}`,
  HackerNews: ({ thread }) => `hackernews:${slugOf(thread)}`,
  Himalayas: ({ query }) => `himalayas:${slugOf(query)}`,
  Jobicy: ({ tag }) => `jobicy:${slugOf(tag)}`,
  Lever: ({ slug }) => `lever:${slug}`,
  RemoteOK: ({ listing }) => `remoteok:${slugOf(listing)}`,
  Remotive: ({ search }) => `remotive:${slugOf(search)}`,
});

const sourceOf = (spec: FeedSpecValue): SourceNameValue => spec._tag;

const companyOf = (spec: FeedSpecValue): Option.Option<string> =>
  Match.value(spec).pipe(
    Match.withReturnType<Option.Option<string>>(),
    Match.tag("Ashby", "Greenhouse", "Lever", ({ company }) => Option.some(company)),
    Match.orElse(() => Option.none())
  );

export const BOARD_INTERVAL_MINUTES = 180;

export const AGGREGATOR_INTERVAL_MINUTES = 120;

export const REMOTIVE_INTERVAL_MINUTES = 360;

export const HACKER_NEWS_INTERVAL_MINUTES = 360;

const intervalOf: (spec: FeedSpecValue) => number = FeedSpec.$match({
  Ashby: () => BOARD_INTERVAL_MINUTES,
  Greenhouse: () => BOARD_INTERVAL_MINUTES,
  HackerNews: () => HACKER_NEWS_INTERVAL_MINUTES,
  Himalayas: () => AGGREGATOR_INTERVAL_MINUTES,
  Jobicy: () => AGGREGATOR_INTERVAL_MINUTES,
  Lever: () => BOARD_INTERVAL_MINUTES,
  RemoteOK: () => AGGREGATOR_INTERVAL_MINUTES,
  Remotive: () => REMOTIVE_INTERVAL_MINUTES,
});

export const feedRefOf = (spec: FeedSpecValue): FeedRef => ({
  company: companyOf(spec),
  key: feedKey(spec),
  minIntervalMinutes: intervalOf(spec),
  source: sourceOf(spec),
});
