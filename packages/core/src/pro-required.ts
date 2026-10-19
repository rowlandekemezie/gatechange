import { Schema } from "effect";

export class ProRequired extends Schema.TaggedError<ProRequired>()(
  "ProRequired",
  {}
) {}
