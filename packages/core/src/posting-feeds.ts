import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { FeedRef } from "./feed.js";
import type { Posting } from "./posting.js";

export class FeedUnavailable extends Schema.TaggedError<FeedUnavailable>()(
  "FeedUnavailable",
  {
    feed: Schema.String,
    message: Schema.String,
  }
) {}

export class PostingFeeds extends Context.Service<
  PostingFeeds,
  {
    readonly catalog: ReadonlyArray<FeedRef>;
    readonly fetch: (feed: FeedRef) => Effect.Effect<ReadonlyArray<Posting>, FeedUnavailable>;
  }
>()("@rat-stack/core/PostingFeeds") {}
