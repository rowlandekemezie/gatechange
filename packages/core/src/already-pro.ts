import { Schema } from "effect";

export class AlreadyPro extends Schema.TaggedError<AlreadyPro>()(
  "AlreadyPro",
  {}
) {}
