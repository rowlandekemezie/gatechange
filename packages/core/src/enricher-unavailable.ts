import { Schema } from "effect";

export class EnricherUnavailable extends Schema.TaggedError<EnricherUnavailable>()(
  "EnricherUnavailable",
  { message: Schema.String }
) {}
