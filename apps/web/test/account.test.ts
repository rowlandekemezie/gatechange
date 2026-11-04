import { describe, expect, it } from "@effect/vitest";
import { Account } from "@rat-stack/core/contracts";
import { Effect, Option, Schema } from "effect";
import { renderToString } from "foldkit/experimental/server";
import { fromString } from "foldkit/url";
import { vi } from "vitest";

import { Message } from "../src/client/account/message.js";
import type { MessageValue } from "../src/client/account/message.js";
import {
  LinkPreview,
  SessionState,
  SignInState,
} from "../src/client/account/model.js";
import type { ModelValue } from "../src/client/account/model.js";
import { init, update } from "../src/client/account/update.js";
import { application } from "../src/client/application.js";
import { ForgetSignInToken } from "../src/client/board/command.js";
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

  it("asks the viewer to wait when the address has had too many links", () => {
    const step = sent(
      signedOut,
      Message.CompletedRequestLink({ email: "a@b.c", outcome: "Limited" })
    );

    expect(step.model.signIn).toStrictEqual(
      SignInState.Editing({
        email: "a@b.c",
        problem: Option.some(
          "Too many sign-in links went to this address. Use the newest one, or wait 15 minutes and ask again."
        ),
      })
    );
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

  it.effect(
    "drops the token from the address bar once the page has read it",
    () =>
      Effect.gen(function* forgetToken() {
        const replaced: unknown[][] = [];

        vi.stubGlobal("window", {
          history: {
            replaceState: (...args: unknown[]) => {
              replaced.push(args);
            },
            state: null,
          },
        });

        const { commands = [], model } = boardInit(
          flags,
          urlAt("/account/confirm?token=abc123")
        );

        expect(commands.map(({ name }) => name)).toContain(
          ForgetSignInToken.name
        );

        yield* ForgetSignInToken().effect;

        vi.unstubAllGlobals();

        expect(replaced).toStrictEqual([[null, "", "/account/confirm"]]);
        expect(model.route).toStrictEqual(
          Route.ConfirmSignIn({ token: "abc123" })
        );
      })
  );
});

const confirmPage = (
  session: ModelValue["session"],
  link: ModelValue["link"]
) =>
  renderToString(
    {
      ...application,
      init: (...args: Parameters<typeof application.init>) => {
        const started = application.init(...args);

        return {
          ...started,
          model: {
            ...started.model,
            account: { ...started.model.account, link, session },
          },
        };
      },
    },
    {
      flags,
      url: "https://jobs.example/account/confirm?token=abc123",
    }
  ).pipe(Effect.map(({ html }) => html));

describe("confirming a sign-in link", () => {
  const carol = Schema.decodeSync(Account)({
    email: "carol@example.com",
    id: "user_carol",
    name: "",
  });

  const adaUpperCase = Schema.decodeSync(Account)({
    email: "ADA@example.com",
    id: "user_ada",
    name: "",
  });

  const signedOutSession = SessionState.SignedOut();
  const adaLink = LinkPreview.Named({ email: "ada@example.com" });

  it("asks who the link belongs to when the page opens", () => {
    const { commands = [] } = boardInit(
      flags,
      urlAt("/account/confirm?token=abc123")
    );

    expect(commands.map(({ name }) => name)).toContain("PreviewLink");
  });

  it("stores what the server said about the link", () => {
    const { model } = update(
      init().model,
      Message.CompletedPreviewLink({ preview: adaLink })
    );

    expect(model.link).toStrictEqual(adaLink);
  });

  it.effect("offers no way in until the link has been named", () =>
    Effect.gen(function* confirmView() {
      const page = yield* confirmPage(signedOutSession, LinkPreview.Checking());

      expect(page).not.toContain("<form");
      expect(page).not.toContain("abc123");
    })
  );

  it.effect("names the account beside the only way in", () =>
    Effect.gen(function* confirmView() {
      const page = yield* confirmPage(signedOutSession, adaLink);

      expect(page).toContain("ada@example.com");
      expect(page).toContain("<form");
      expect(page).toContain("abc123");
    })
  );

  it.effect("offers no way in and no address for a refused link", () =>
    Effect.gen(function* confirmView() {
      const page = yield* confirmPage(signedOutSession, LinkPreview.Refused());

      expect(page).not.toContain("<form");
      expect(page).not.toContain("abc123");
      expect(page).toContain("expired or has already been used");
      expect(page).toContain('href="/account"');
    })
  );

  it.effect("offers no way in when the link could not be checked", () =>
    Effect.gen(function* confirmView() {
      const page = yield* confirmPage(signedOutSession, LinkPreview.Unknown());

      expect(page).not.toContain("<form");
      expect(page).toContain("Open the link from your email again");
    })
  );

  it.effect("warns a member before moving them into another account", () =>
    Effect.gen(function* confirmView() {
      const page = yield* confirmPage(
        SessionState.SignedIn({ account: carol }),
        adaLink
      );

      expect(page).toContain("carol@example.com");
      expect(page).toContain("ada@example.com");
      expect(page).toContain("Stay signed in");
      expect(page).toContain("Switch to ada@example.com");
      expect(page).toContain("<form");
    })
  );

  it.effect("spends no link for a member already in that account", () =>
    Effect.gen(function* confirmView() {
      const page = yield* confirmPage(
        SessionState.SignedIn({ account: adaUpperCase }),
        adaLink
      );

      expect(page).toContain("already signed in");
      expect(page).not.toContain("<form");
    })
  );

  it.effect("waits for the session before offering the way in", () =>
    Effect.gen(function* confirmView() {
      const page = yield* confirmPage(SessionState.Checking(), adaLink);

      expect(page).not.toContain("<form");
    })
  );
});
