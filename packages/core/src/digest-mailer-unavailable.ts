import { Schema } from "effect";

export class DigestMailerUnavailable extends Schema.TaggedError<DigestMailerUnavailable>()(
  "DigestMailerUnavailable",
  { message: Schema.String, quotaExhausted: Schema.Boolean }
) {}
