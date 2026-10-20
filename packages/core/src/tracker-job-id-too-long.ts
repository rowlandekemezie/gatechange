import { Schema } from "effect";

export class TrackerJobIdTooLong extends Schema.TaggedError<TrackerJobIdTooLong>()(
  "TrackerJobIdTooLong",
  { limit: Schema.Finite }
) {}
