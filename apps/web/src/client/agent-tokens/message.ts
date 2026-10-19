import {
  AgentToken,
  AgentTokenId,
  IssuedAgentToken,
} from "@rat-stack/core/contracts";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

export const IssueProblem = Schema.Literals([
  "AtLimit",
  "ProRequired",
  "Failed",
]);

export type IssueProblemValue = typeof IssueProblem.Type;

export const Message = defineMessageUnion({
  ClickedRevokeToken: { id: AgentTokenId },
  CompletedFetchTokens: { tokens: Schema.Option(Schema.Array(AgentToken)) },
  CompletedIssueToken: { issued: IssuedAgentToken },
  CompletedRevokeToken: { id: AgentTokenId, ok: Schema.Boolean },
  FailedIssueToken: { problem: IssueProblem },
  SubmittedIssueToken: {},
  UpdatedTokenLabel: { value: Schema.String },
});

export type MessageValue = typeof Message.Type;
