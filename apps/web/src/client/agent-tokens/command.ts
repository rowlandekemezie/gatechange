import { AgentTokenId, AgentTokenLabel } from "@rat-stack/core/contracts";
import { Effect, Option, Predicate, Schema } from "effect";
import { Command } from "foldkit";

import { JobQueries } from "../board/queries.js";
import { Message } from "./message.js";
import type { IssueProblemValue } from "./message.js";

const problemOf = (failure: { readonly _tag: string }): IssueProblemValue => {
  if (Predicate.isTagged(failure, "AgentTokenLimit")) {
    return "AtLimit";
  }

  return Predicate.isTagged(failure, "ProRequired") ? "ProRequired" : "Failed";
};

export const FetchTokens = Command.define("FetchTokens", {
  args: { generation: Schema.Finite },
  execute: ({ generation }) =>
    JobQueries.use((queries) => queries.agentTokens).pipe(
      Effect.match({
        onFailure: () =>
          Message.CompletedFetchTokens({ generation, tokens: Option.none() }),
        onSuccess: (tokens) =>
          Message.CompletedFetchTokens({
            generation,
            tokens: Option.some(tokens),
          }),
      })
    ),
  messages: [Message.CompletedFetchTokens],
});

export const IssueToken = Command.define("IssueToken", {
  args: { generation: Schema.Finite, label: AgentTokenLabel },
  execute: ({ generation, label }) =>
    JobQueries.use((queries) => queries.issueAgentToken(label)).pipe(
      Effect.match({
        onFailure: (failure) =>
          Message.FailedIssueToken({ generation, problem: problemOf(failure) }),
        onSuccess: (issued) =>
          Message.CompletedIssueToken({ generation, issued }),
      })
    ),
  messages: [Message.CompletedIssueToken, Message.FailedIssueToken],
});

export const RevokeToken = Command.define("RevokeToken", {
  args: { generation: Schema.Finite, id: AgentTokenId },
  execute: ({ generation, id }) =>
    JobQueries.use((queries) => queries.revokeAgentToken(id)).pipe(
      Effect.match({
        onFailure: () =>
          Message.CompletedRevokeToken({ generation, id, ok: false }),
        onSuccess: () =>
          Message.CompletedRevokeToken({ generation, id, ok: true }),
      })
    ),
  messages: [Message.CompletedRevokeToken],
});
