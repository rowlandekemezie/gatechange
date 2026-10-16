import { Context } from "effect";
import type { Effect } from "effect";

import type { FeedRef } from "./feed.js";
import type { FeedUnavailable } from "./feed-unavailable.js";
import type { PostingValue } from "./posting.js";

export class PostingFeeds extends Context.Service<
  PostingFeeds,
  {
    readonly catalog: readonly FeedRef[];
    readonly fetch: (feed: FeedRef) => Effect.Effect<readonly PostingValue[], FeedUnavailable>;
  }
>()("@rat-stack/core/PostingFeeds") {}
