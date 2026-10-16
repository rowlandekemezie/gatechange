import { Schema } from "effect";

export class FeedUnavailable extends Schema.TaggedError<FeedUnavailable>()(
  "FeedUnavailable",
  {
    feed: Schema.String,
    message: Schema.String,
  }
) {}
