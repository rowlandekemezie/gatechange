import { Schema } from "effect";

export class AgentTokenLimit extends Schema.TaggedError<AgentTokenLimit>()(
  "AgentTokenLimit",
  { limit: Schema.Int }
) {}
