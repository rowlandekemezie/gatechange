import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

export const Message = defineMessageUnion({
  ClickedAllowConnect: {},
  ClickedDenyConnect: {},
  CompletedAnswerConnect: {},
  CompletedFetchConnectingClient: { name: Schema.Option(Schema.String) },
  FailedAnswerConnect: {},
});

export type MessageValue = typeof Message.Type;
