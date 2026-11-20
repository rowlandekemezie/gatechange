import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import { load } from "foldkit/navigation";

import { AuthClient } from "../account/auth-client.js";
import { Message } from "./message.js";

export const FetchConnectingClient = Command.define("FetchConnectingClient", {
  args: { clientId: Schema.String },
  execute: ({ clientId }) =>
    AuthClient.use((auth) => auth.connectingClient(clientId)).pipe(
      Effect.orElseSucceed(() => Option.none()),
      Effect.map((name) => Message.CompletedFetchConnectingClient({ name }))
    ),
  messages: [Message.CompletedFetchConnectingClient],
});

export const AnswerConnect = Command.define("AnswerConnect", {
  args: { accept: Schema.Boolean, signed: Schema.String },
  execute: ({ accept, signed }) =>
    AuthClient.use((auth) => auth.answerConnect(signed, accept)).pipe(
      Effect.flatMap(load),
      Effect.match({
        onFailure: () => Message.FailedAnswerConnect(),
        onSuccess: () => Message.CompletedAnswerConnect(),
      })
    ),
  messages: [Message.FailedAnswerConnect, Message.CompletedAnswerConnect],
});
