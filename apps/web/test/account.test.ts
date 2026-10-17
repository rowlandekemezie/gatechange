import { describe, expect, it } from "@effect/vitest";
import { Account } from "@rat-stack/core/contracts";
import { Option, Schema } from "effect";
import { fromString } from "foldkit/url";

import { Message } from "../src/client/account/message.js";
import type { MessageValue } from "../src/client/account/message.js";
import { SessionState, SignInState } from "../src/client/account/model.js";
import type { ModelValue } from "../src/client/account/model.js";
import { init, update } from "../src/client/account/update.js";
import { Preload } from "../src/client/board/model.js";
import { init as boardInit } from "../src/client/board/update.js";
import { accountRouter, Route, routeOfUrl } from "../src/client/route.js";

const ada = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "",
});

interface Step {
  readonly commands: readonly {
    readonly name: string;
    readonly args?: unknown;
  }[];
  readonly model: ModelValue;
}

const sent = (step: Step, message: MessageValue): Step => {
  const { commands = [], model } = update(step.model, message);

  return { commands, model };
};

const signedOut = sent(
  { commands: [], model: init().model },
  Message.CompletedFetchSession({ account: Option.none() })
);

const typed = (email: string) =>
  sent(signedOut, Message.UpdatedSignInEmail({ value: email }));

const flags = { origin: "https://jobs.example", preload: Preload.Nothing() };

const urlAt = (path: string) =>
  Option.getOrThrow(fromString(`https://jobs.example${path}`));

describe("account", () => {
  it("asks the server who is signed in when the app starts", () => {
    const names = (boardInit(flags, urlAt("/")).commands ?? []).map(
      (command) => command.name
    );

    expect(names).toContain("FetchSession");
  });

  it("keeps a malformed email on the page with a problem and sends nothing", () => {
    const step = sent(typed("not-an-email"), Message.SubmittedSignIn());

    expect(step.commands).toStrictEqual([]);
    expect(step.model.signIn).toStrictEqual(
      SignInState.Editing({
        email: "not-an-email",
        problem: Option.some("Enter an email address like you@company.com."),
      })
    );
  });

  it("requests one link for a trimmed email and waits for it", () => {
    const step = sent(typed("  ada@example.com "), Message.SubmittedSignIn());

    expect(
      step.commands.map(({ args, name }) => ({ args, name }))
    ).toStrictEqual([
      { args: { email: "ada@example.com" }, name: "RequestLink" },
    ]);
    expect(step.model.signIn).toStrictEqual(
      SignInState.Sending({ email: "ada@example.com" })
    );
    expect(sent(step, Message.SubmittedSignIn()).commands).toStrictEqual([]);
  });

  it("tells the viewer to check their inbox once the link is sent", () => {
    const step = sent(
      signedOut,
      Message.CompletedRequestLink({
        email: "ada@example.com",
        outcome: "Sent",
      })
    );

    expect(step.model.signIn).toStrictEqual(
      SignInState.Sent({ email: "ada@example.com" })
    );
  });

  it("shows the server's refusal of an address inline", () => {
    const step = sent(
      signedOut,
      Message.CompletedRequestLink({ email: "a@b.c", outcome: "Invalid" })
    );

    expect(
      Schema.is(SignInState.Editing)(step.model.signIn) &&
        Option.isSome(step.model.signIn.problem)
    ).toBe(true);
  });

  it("holds the member's account once the session resolves", () => {
    const step = sent(
      { commands: [], model: init().model },
      Message.CompletedFetchSession({ account: Option.some(ada) })
    );

    expect(step.model.session).toStrictEqual(
      SessionState.SignedIn({ account: ada })
    );
  });

  it("re-reads the session from the server after signing out", () => {
    const signedIn = sent(
      { commands: [], model: init().model },
      Message.CompletedFetchSession({ account: Option.some(ada) })
    );

    const out = sent(signedIn, Message.CompletedSignOut());

    expect(out.model.session).toStrictEqual(SessionState.Checking());
    expect(out.commands.map(({ name }) => name)).toContain("FetchSession");
  });

  it("tells a refused magic link apart from a failed social sign-in", () => {
    expect(routeOfUrl(urlAt("/account?error=INVALID_TOKEN"))).toStrictEqual(
      Route.Account({ notice: "LinkRefused" })
    );
    expect(routeOfUrl(urlAt("/account?error=EXPIRED_TOKEN"))).toStrictEqual(
      Route.Account({ notice: "LinkRefused" })
    );
    expect(routeOfUrl(urlAt("/account?error=access_denied"))).toStrictEqual(
      Route.Account({ notice: "SignInFailed" })
    );
    expect(accountRouter({ notice: "None" })).toBe("/account");
  });

  it("opens the emailed confirm link as its own page that spends nothing on load", () => {
    expect(routeOfUrl(urlAt("/account/confirm?token=abc123"))).toStrictEqual(
      Route.ConfirmSignIn({ token: "abc123" })
    );
    expect(
      boardInit(flags, urlAt("/account/confirm?token=abc123")).commands?.map(
        ({ name }) => name
      )
    ).not.toContain("RequestLink");
  });
});
