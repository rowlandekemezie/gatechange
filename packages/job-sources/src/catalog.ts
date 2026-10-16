import { Array, Effect, Layer, Match, Option } from "effect";
import { HttpClient } from "effect/http";
import { FeedUnavailable, PostingFeeds } from "@rat-stack/core";
import type { FeedRef } from "@rat-stack/core";

import {
  himalayasPostings,
  jobicyPostings,
  remoteOkPostings,
  remotivePostings,
} from "./aggregators.js";
import { ashbyPostings, greenhousePostings, leverPostings } from "./ats.js";
import { companyBoards } from "./boards.js";
import type { CompanyBoard } from "./boards.js";
import { FeedSpec, feedKey, feedRefOf } from "./feed-spec.js";
import { hackerNewsPostings } from "./hacker-news.js";

export const aggregatorFeeds: ReadonlyArray<FeedSpec> = [
  FeedSpec.RemoteOK(),
  FeedSpec.Remotive({ search: "engineering manager" }),
  FeedSpec.Remotive({ search: "director of engineering" }),
  FeedSpec.Himalayas({ query: "engineering manager" }),
  FeedSpec.Himalayas({ query: "director of engineering" }),
  FeedSpec.Himalayas({ query: "vp engineering" }),
  FeedSpec.Jobicy({ tag: "engineering manager" }),
  FeedSpec.Jobicy({ tag: "director of engineering" }),
  FeedSpec.HackerNews(),
];

export const boardFeed = (board: CompanyBoard): FeedSpec =>
  Match.value(board.ats).pipe(
    Match.withReturnType<FeedSpec>(),
    Match.when("ashby", () => FeedSpec.Ashby({ company: board.name, slug: board.slug })),
    Match.when("greenhouse", () => FeedSpec.Greenhouse({ company: board.name, slug: board.slug })),
    Match.when("lever", () => FeedSpec.Lever({ company: board.name, slug: board.slug })),
    Match.exhaustive
  );

export const feedSpecs = (boards: ReadonlyArray<CompanyBoard>): ReadonlyArray<FeedSpec> => [
  ...aggregatorFeeds,
  ...Array.map(boards, boardFeed),
];

const postingsOf = (spec: FeedSpec) => {
  const key = feedKey(spec);

  return FeedSpec.$match(spec, {
    Ashby: ({ slug }) => ashbyPostings(key, slug),
    Greenhouse: ({ slug }) => greenhousePostings(key, slug),
    HackerNews: () => hackerNewsPostings(key),
    Himalayas: ({ query }) => himalayasPostings(key, query),
    Jobicy: ({ tag }) => jobicyPostings(key, tag),
    Lever: ({ slug }) => leverPostings(key, slug),
    RemoteOK: () => remoteOkPostings(key),
    Remotive: ({ search }) => remotivePostings(key, search),
  });
};

export const postingFeedsLayer = (boards: ReadonlyArray<CompanyBoard> = companyBoards) =>
  Layer.effect(
    PostingFeeds,
    Effect.gen(function* makePostingFeeds() {
      const client = yield* HttpClient.HttpClient;
      const specs = feedSpecs(boards);
      const catalog: ReadonlyArray<FeedRef> = Array.map(specs, feedRefOf);

      return PostingFeeds.of({
        catalog,
        fetch: (feed) =>
          Option.match(
            Array.findFirst(specs, (spec) => feedKey(spec) === feed.key),
            {
              onNone: () =>
                Effect.fail(
                  new FeedUnavailable({
                    feed: feed.key,
                    message: "This feed is not in the catalog. Remove it from the feeds table.",
                  })
                ),
              onSome: (spec) =>
                postingsOf(spec).pipe(Effect.provideService(HttpClient.HttpClient, client)),
            }
          ),
      });
    })
  );
