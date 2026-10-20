import { AgentToken, AgentTokenLabel } from "@rat-stack/core/contracts";
import { Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { IssueProblem } from "./message.js";

export const TokensState = defineTaggedUnion({
  Failed: {},
  Loaded: { tokens: Schema.Array(AgentToken) },
  Loading: {},
  NotAsked: {},
});

export const IssueState = defineTaggedUnion({
  Idle: {},
  Issued: { secret: Schema.String },
  Issuing: {},
  Refused: { problem: IssueProblem },
});

export type IssueStateValue = typeof IssueState.Type;

export const Model = Schema.Struct({
  active: Schema.Boolean,
  generation: Schema.Finite,
  issue: IssueState,
  label: Schema.String,
  revoking: Schema.Array(Schema.String),
  tokens: TokensState,
});

export type ModelValue = typeof Model.Type;

const decodeLabel = Schema.decodeUnknownOption(AgentTokenLabel);

export const labelOf = (draft: string) => decodeLabel(draft.trim());

export const canIssue = (model: ModelValue) =>
  model.active &&
  Schema.is(TokensState.Loaded)(model.tokens) &&
  !Schema.is(IssueState.Issuing)(model.issue) &&
  Option.isSome(labelOf(model.label));
