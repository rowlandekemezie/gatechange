import { AgentTokenId, AgentTokenLabel } from "@rat-stack/core/contracts";
import { Effect, Option, Predicate } from "effect";
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
  execute: JobQueries.use((queries) => queries.agentTokens).pipe(
    Effect.match({
      onFailure: () => Message.CompletedFetchTokens({ tokens: Option.none() }),
      onSuccess: (tokens) =>
        Message.CompletedFetchTokens({ tokens: Option.some(tokens) }),
    })
  ),
  messages: [Message.CompletedFetchTokens],
});

export const IssueToken = Command.define("IssueToken", {
  args: { label: AgentTokenLabel },
  execute: ({ label }) =>
    JobQueries.use((queries) => queries.issueAgentToken(label)).pipe(
      Effect.match({
        onFailure: (failure) =>
          Message.FailedIssueToken({ problem: problemOf(failure) }),
        onSuccess: (issued) => Message.CompletedIssueToken({ issued }),
      })
    ),
  messages: [Message.CompletedIssueToken, Message.FailedIssueToken],
});

export const RevokeToken = Command.define("RevokeToken", {
  args: { id: AgentTokenId },
  execute: ({ id }) =>
    JobQueries.use((queries) => queries.revokeAgentToken(id)).pipe(
      Effect.match({
        onFailure: () => Message.CompletedRevokeToken({ id, ok: false }),
        onSuccess: () => Message.CompletedRevokeToken({ id, ok: true }),
      })
    ),
  messages: [Message.CompletedRevokeToken],
});
