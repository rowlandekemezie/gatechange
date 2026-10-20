import { Option, Schema } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { JobQueries } from "../board/queries.js";
import { FetchTokens, IssueToken, RevokeToken } from "./command.js";
import { Message } from "./message.js";
import type { MessageValue } from "./message.js";
import { canIssue, IssueState, labelOf, TokensState } from "./model.js";
import type { ModelValue } from "./model.js";

type UpdateReturn = Update.Return<ModelValue, MessageValue, JobQueries>;

const initial: ModelValue = {
  active: false,
  generation: 0,
  issue: IssueState.Idle(),
  label: "",
  revoking: [],
  tokens: TokensState.NotAsked(),
};

export const init = (): UpdateReturn => ({ model: initial });

export const invalidated = (model: ModelValue): ModelValue => ({
  ...initial,
  generation: model.generation + 1,
});

export const entered = (model: ModelValue): UpdateReturn => {
  const generation = model.generation + 1;

  return {
    commands: [FetchTokens({ generation })],
    model: {
      ...initial,
      active: true,
      generation,
      tokens: TokensState.Loading(),
    },
  };
};

const submitted = (model: ModelValue): UpdateReturn =>
  canIssue(model)
    ? Option.match(labelOf(model.label), {
        onNone: () => ({ model }),
        onSome: (label) => ({
          commands: [IssueToken({ generation: model.generation, label })],
          model: modifyFields(model, { issue: () => IssueState.Issuing() }),
        }),
      })
    : { model };

export const update = (
  model: ModelValue,
  message: MessageValue
): UpdateReturn => {
  if (
    !model.active ||
    ("generation" in message && message.generation !== model.generation)
  ) {
    return { model };
  }

  return Message.match<UpdateReturn>(message, {
    ClickedRevokeToken: ({ id }) =>
      model.revoking.includes(id)
        ? { model }
        : {
            commands: [RevokeToken({ generation: model.generation, id })],
            model: modifyFields(model, { revoking: (ids) => [...ids, id] }),
          },
    CompletedFetchTokens: ({ tokens }) =>
      Schema.is(TokensState.Loading)(model.tokens)
        ? {
            model: modifyFields(model, {
              tokens: () =>
                Option.match(tokens, {
                  onNone: () => TokensState.Failed(),
                  onSome: (found) => TokensState.Loaded({ tokens: found }),
                }),
            }),
          }
        : { model },
    CompletedIssueToken: ({ issued }) =>
      Schema.is(IssueState.Issuing)(model.issue)
        ? {
            model: modifyFields(model, {
              issue: () => IssueState.Issued({ secret: issued.secret }),
              label: () => "",
              tokens: (state) =>
                Schema.is(TokensState.Loaded)(state)
                  ? TokensState.Loaded({
                      tokens: [issued.token, ...state.tokens],
                    })
                  : state,
            }),
          }
        : { model },
    CompletedRevokeToken: ({ id, ok }) =>
      model.revoking.includes(id)
        ? {
            model: modifyFields(model, {
              revoking: (ids) => ids.filter((pending) => pending !== id),
              tokens: (state) =>
                ok && Schema.is(TokensState.Loaded)(state)
                  ? TokensState.Loaded({
                      tokens: state.tokens.filter((token) => token.id !== id),
                    })
                  : state,
            }),
          }
        : { model },
    FailedIssueToken: ({ problem }) =>
      Schema.is(IssueState.Issuing)(model.issue)
        ? {
            model: modifyFields(model, {
              issue: () => IssueState.Refused({ problem }),
            }),
          }
        : { model },
    SubmittedIssueToken: () => submitted(model),
    UpdatedTokenLabel: ({ value }) => ({
      model: modifyFields(model, { label: () => value }),
    }),
  });
};
