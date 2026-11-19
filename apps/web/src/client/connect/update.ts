import { Option, Schema } from "effect";
import type { Update } from "foldkit";

import type { AuthClient } from "../account/auth-client.js";
import { AnswerConnect, FetchConnectingClient } from "./command.js";
import { Message } from "./message.js";
import type { MessageValue } from "./message.js";
import { ClientName, ConnectState, connectRequestOf } from "./model.js";
import type { ModelValue } from "./model.js";

type UpdateReturn = Update.Return<ModelValue, MessageValue, AuthClient>;

export const init = (): UpdateReturn => ({
  model: { state: ConnectState.Invalid() },
});

export const entered = (search: string): UpdateReturn => ({
  model: {
    state: Option.match(connectRequestOf(search), {
      onNone: () => ConnectState.Invalid(),
      onSome: (request) =>
        ConnectState.Ready({ client: ClientName.NotAsked(), request }),
    }),
  },
});

export const signedIn = (model: ModelValue): UpdateReturn =>
  Schema.is(ConnectState.Ready)(model.state) &&
  Schema.is(ClientName.NotAsked)(model.state.client)
    ? {
        commands: [
          FetchConnectingClient({ clientId: model.state.request.clientId }),
        ],
        model: {
          state: ConnectState.Ready({
            client: ClientName.Loading(),
            request: model.state.request,
          }),
        },
      }
    : { model };

const answered = (model: ModelValue, accept: boolean): UpdateReturn =>
  Schema.is(ConnectState.Ready)(model.state)
    ? {
        commands: [
          AnswerConnect({ accept, signed: model.state.request.signed }),
        ],
        model: {
          state: ConnectState.Answering({
            accept,
            client: model.state.client,
            request: model.state.request,
          }),
        },
      }
    : { model };

export const update = (
  model: ModelValue,
  message: MessageValue
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedAllowConnect: () => answered(model, true),
    ClickedDenyConnect: () => answered(model, false),
    CompletedAnswerConnect: () => ({ model }),
    CompletedFetchConnectingClient: ({ name }) => ({
      model: Schema.is(ConnectState.Ready)(model.state)
        ? {
            state: ConnectState.Ready({
              client: Option.match(name, {
                onNone: () => ClientName.Unnamed(),
                onSome: (found) => ClientName.Named({ name: found }),
              }),
              request: model.state.request,
            }),
          }
        : model,
    }),
    FailedAnswerConnect: () => ({
      model: Schema.is(ConnectState.Answering)(model.state)
        ? {
            state: ConnectState.Failed({
              client: model.state.client,
              request: model.state.request,
            }),
          }
        : model,
    }),
  });
