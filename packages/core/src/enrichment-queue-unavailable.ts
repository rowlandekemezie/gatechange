import { Schema } from "effect";

export class EnrichmentQueueUnavailable extends Schema.TaggedError<EnrichmentQueueUnavailable>()(
  "EnrichmentQueueUnavailable",
  { message: Schema.String }
) {}
