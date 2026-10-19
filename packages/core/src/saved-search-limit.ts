import { Schema } from "effect";

export class SavedSearchLimit extends Schema.TaggedError<SavedSearchLimit>()(
  "SavedSearchLimit",
  { limit: Schema.Int }
) {}
