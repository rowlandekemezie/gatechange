import { Schema } from "effect";

export class TrackerFull extends Schema.TaggedError<TrackerFull>()(
  "TrackerFull",
  { limit: Schema.Finite }
) {}
