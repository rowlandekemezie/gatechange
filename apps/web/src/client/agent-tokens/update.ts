import { Option, Schema } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { JobQueries } from "../board/queries.js";
import { FetchTokens, IssueToken, RevokeToken } from "./command.js";
import { Message } from "./message.js";
import type { MessageValue } from "./message.js";
import { IssueState, labelOf, TokensState } from "./model.js";
import type { ModelValue } from "./model.js";

type UpdateReturn = Update.Return<ModelValue, MessageValue, JobQueries>;

const initial: ModelValue = {
  issue: IssueState.Idle(),
  label: "",
  revoking: [],
  tokens: TokensState.NotAsked(),
};

export const init = (): UpdateReturn => ({ model: initial });

export const signedOut = (): ModelValue => initial;

export const entered = (model: ModelValue): UpdateReturn => ({
  commands: [FetchTokens()],
  model: modifyFields(model, {
    issue: () => IssueState.Idle(),
    tokens: (state) =>
      Schema.is(TokensState.Loaded)(state) ? state : TokensState.Loading(),
  }),
});

const submitted = (model: ModelValue): UpdateReturn =>
  Schema.is(IssueState.Issuing)(model.issue)
    ? { model }
    : Option.match(labelOf(model.label), {
        onNone: () => ({ model }),
        onSome: (label) => ({
          commands: [IssueToken({ label })],
          model: modifyFields(model, { issue: () => IssueState.Issuing() }),
        }),
      });

export const update = (
  model: ModelValue,
  message: MessageValue
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedRevokeToken: ({ id }) =>
      model.revoking.includes(id)
        ? { model }
        : {
            commands: [RevokeToken({ id })],
            model: modifyFields(model, { revoking: (ids) => [...ids, id] }),
          },
    CompletedFetchTokens: ({ tokens }) => ({
      model: modifyFields(model, {
        tokens: () =>
          Option.match(tokens, {
            onNone: () => TokensState.Failed(),
            onSome: (found) => TokensState.Loaded({ tokens: found }),
          }),
      }),
    }),
    CompletedIssueToken: ({ issued }) => ({
      model: modifyFields(model, {
        issue: () => IssueState.Issued({ secret: issued.secret }),
        label: () => "",
        tokens: (state) =>
          Schema.is(TokensState.Loaded)(state)
            ? TokensState.Loaded({ tokens: [issued.token, ...state.tokens] })
            : state,
      }),
    }),
    CompletedRevokeToken: ({ id, ok }) => ({
      model: modifyFields(model, {
        revoking: (ids) => ids.filter((pending) => pending !== id),
        tokens: (state) =>
          ok && Schema.is(TokensState.Loaded)(state)
            ? TokensState.Loaded({
                tokens: state.tokens.filter((token) => token.id !== id),
              })
            : state,
      }),
    }),
    FailedIssueToken: ({ problem }) => ({
      model: modifyFields(model, {
        issue: () => IssueState.Refused({ problem }),
      }),
    }),
    SubmittedIssueToken: () => submitted(model),
    UpdatedTokenLabel: ({ value }) => ({
      model: modifyFields(model, { label: () => value }),
    }),
  });
