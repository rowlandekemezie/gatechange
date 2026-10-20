import { Schema } from "effect";

export class TrackerStorageFull extends Schema.TaggedError<TrackerStorageFull>()(
  "TrackerStorageFull",
  { limit: Schema.Finite }
) {}
