import { Schema } from "effect";

export class PostingGone extends Schema.TaggedError<PostingGone>()(
  "PostingGone",
  { id: Schema.String, message: Schema.String }
) {}
