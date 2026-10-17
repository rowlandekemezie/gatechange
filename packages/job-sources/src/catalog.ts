import { FeedUnavailable, PostingFeeds } from "@rat-stack/core";
import type { FeedRef } from "@rat-stack/core";
import { Array, Effect, Layer, Match, Option, pipe } from "effect";
import { HttpClient } from "effect/http";

import {
  himalayasPostings,
  jobicyPostings,
  remoteOkPostings,
  remotivePostings,
} from "./aggregators.js";
import { ashbyPostings, greenhousePostings, leverPostings } from "./ats.js";
import { companyBoards } from "./boards.js";
import type { CompanyBoardValue } from "./boards.js";
import { FeedSpec, feedKey, feedRefOf } from "./feed-spec.js";
import type { FeedSpecValue } from "./feed-spec.js";
import { hackerNewsPostings } from "./hacker-news.js";
import { smartRecruitersPostings } from "./smartrecruiters.js";
import { workablePostings } from "./workable.js";

export const aggregatorFeeds: readonly FeedSpecValue[] = [
  FeedSpec.RemoteOK({ listing: "all" }),
  FeedSpec.Remotive({ search: "engineering manager" }),
  FeedSpec.Remotive({ search: "director of engineering" }),
  FeedSpec.Himalayas({ query: "engineering manager" }),
  FeedSpec.Himalayas({ query: "director of engineering" }),
  FeedSpec.Himalayas({ query: "vp engineering" }),
  FeedSpec.Jobicy({ tag: "engineering manager" }),
  FeedSpec.Jobicy({ tag: "director of engineering" }),
  FeedSpec.HackerNews({ thread: "who is hiring" }),
];

export const boardFeed = (board: CompanyBoardValue): FeedSpecValue =>
  Match.value(board.ats).pipe(
    Match.withReturnType<FeedSpecValue>(),
    Match.when("ashby", () =>
      FeedSpec.Ashby({ company: board.name, slug: board.slug })
    ),
    Match.when("greenhouse", () =>
      FeedSpec.Greenhouse({ company: board.name, slug: board.slug })
    ),
    Match.when("lever", () =>
      FeedSpec.Lever({ company: board.name, slug: board.slug })
    ),
    Match.when("smartrecruiters", () =>
      FeedSpec.SmartRecruiters({ company: board.name, slug: board.slug })
    ),
    Match.when("workable", () =>
      FeedSpec.Workable({ company: board.name, slug: board.slug })
    ),
    Match.exhaustive
  );

export const feedSpecs = (
  boards: readonly CompanyBoardValue[]
): readonly FeedSpecValue[] => [
  ...aggregatorFeeds,
  ...pipe(boards, Array.map(boardFeed)),
];

const postingsOf = (spec: FeedSpecValue) => {
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
    SmartRecruiters: ({ slug }) => smartRecruitersPostings(key, slug),
    Workable: ({ slug }) => workablePostings(key, slug),
  });
};

export const postingFeedsLayer = (
  boards: readonly CompanyBoardValue[] = companyBoards
) =>
  Layer.effect(
    PostingFeeds,
    Effect.gen(function* makePostingFeeds() {
      const client = yield* HttpClient.HttpClient;
      const specs = feedSpecs(boards);
      const catalog: readonly FeedRef[] = pipe(specs, Array.map(feedRefOf));

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
                    message:
                      "This feed is not in the catalog. Remove it from the feeds table.",
                  })
                ),
              onSome: (spec) =>
                postingsOf(spec).pipe(
                  Effect.provideService(HttpClient.HttpClient, client)
                ),
            }
          ),
      });
    })
  );
