import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { Message as TokensMessage } from "../src/client/agent-tokens/message.js";
import type { MessageValue as TokensMessageValue } from "../src/client/agent-tokens/message.js";
import { IssueState, TokensState } from "../src/client/agent-tokens/model.js";
import { Message } from "../src/client/board/message.js";
import {
  leftTo,
  named,
  sentAll,
  signedIn,
  started,
  tokenOf,
  walked,
} from "./state-machines.support.js";
import type { Step } from "./state-machines.support.js";

const SECRET = "jobs_pat_s3cret";

const laptop = tokenOf({
  createdAt: Date.UTC(2026, 9, 1),
  id: "token-laptop",
  label: "Laptop",
});

const ci = tokenOf({
  createdAt: Date.UTC(2026, 9, 18),
  id: "token-ci",
  label: "CI",
});

const at = (message: TokensMessageValue) =>
  Message.GotAgentTokensMessage({ message });

const generationOf = (step: Step) => step.model.agentTokens.generation;

const listedOn = (step: Step, tokens: readonly (typeof laptop)[]) =>
  sentAll(step, [
    at(
      TokensMessage.CompletedFetchTokens({
        generation: generationOf(step),
        tokens: Option.some(tokens),
      })
    ),
  ]);

const ready = () =>
  listedOn(sentAll(started("/account"), [signedIn]), [laptop]);

const issuing = () =>
  sentAll(ready(), [
    at(TokensMessage.UpdatedTokenLabel({ value: "CI" })),
    at(TokensMessage.SubmittedIssueToken()),
  ]);

describe("AgentTokens model replay", () => {
  it("EverySecretShown: leaving the account page while a token is created still shows its secret on return", () => {
    const sent = issuing();
    const issuedFor = generationOf(sent);

    const back = sentAll(sent, [
      leftTo("/"),
      at(
        TokensMessage.CompletedIssueToken({
          generation: issuedFor,
          issued: { secret: SECRET, token: ci },
        })
      ),
      leftTo("/account"),
    ]);

    const relisted = listedOn(back, [ci, laptop]);

    expect(relisted.model.agentTokens.issue).toStrictEqual(
      IssueState.Issued({ secret: SECRET })
    );
  });

  it("EverySecretShown: coming back before the token is created shows its secret once and lists it once", () => {
    const sent = issuing();
    const issuedFor = generationOf(sent);

    const back = listedOn(sentAll(sent, [leftTo("/"), leftTo("/account")]), [
      ci,
      laptop,
    ]);

    const shown = sentAll(back, [
      at(
        TokensMessage.CompletedIssueToken({
          generation: issuedFor,
          issued: { secret: SECRET, token: ci },
        })
      ),
    ]);

    expect(shown.model.agentTokens.issue).toStrictEqual(
      IssueState.Issued({ secret: SECRET })
    );
    expect(shown.model.agentTokens.tokens).toStrictEqual(
      TokensState.Loaded({ tokens: [ci, laptop] })
    );
  });

  it("holds OneCreateAtATime: a double tap on Create sends one request", () => {
    const path = walked(ready(), [
      at(TokensMessage.UpdatedTokenLabel({ value: "CI" })),
      at(TokensMessage.SubmittedIssueToken()),
      at(TokensMessage.SubmittedIssueToken()),
    ]);

    expect(named(path.all, "IssueToken")).toHaveLength(1);
  });

  it("holds SecretGoneAfterLeaving: the secret is off screen once you leave", () => {
    const sent = issuing();

    const shown = sentAll(sent, [
      at(
        TokensMessage.CompletedIssueToken({
          generation: generationOf(sent),
          issued: { secret: SECRET, token: ci },
        })
      ),
    ]);

    expect(shown.model.agentTokens.issue).toStrictEqual(
      IssueState.Issued({ secret: SECRET })
    );

    const left = sentAll(shown, [leftTo("/")]);

    expect(left.model.agentTokens.issue).toStrictEqual(IssueState.Idle());
    expect(JSON.stringify(left.model)).not.toContain(SECRET);
  });

  it("holds CapHolds: the server's limit answer shows the refusal", () => {
    const sent = issuing();

    const refused = sentAll(sent, [
      at(
        TokensMessage.FailedIssueToken({
          generation: generationOf(sent),
          problem: "AtLimit",
        })
      ),
    ]);

    expect(refused.model.agentTokens.issue).toStrictEqual(
      IssueState.Refused({ problem: "AtLimit" })
    );
  });
});
