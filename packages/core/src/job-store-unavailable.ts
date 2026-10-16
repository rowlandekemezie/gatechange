import { Schema } from "effect";

export class JobStoreUnavailable extends Schema.TaggedError<JobStoreUnavailable>()(
  "JobStoreUnavailable",
  {
    message: Schema.String,
    operation: Schema.String,
  }
) {}
