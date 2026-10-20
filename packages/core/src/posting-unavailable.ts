import { Schema } from "effect";

export class PostingUnavailable extends Schema.TaggedError<PostingUnavailable>()(
  "PostingUnavailable",
  { id: Schema.String, message: Schema.String }
) {}
