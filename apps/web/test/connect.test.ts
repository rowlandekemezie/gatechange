import { describe, expect, it } from "@effect/vitest";
import { Account } from "@rat-stack/core/contracts";
import { Effect, Option, Schema } from "effect";
import { renderToString } from "foldkit/experimental/server";
import { fromString } from "foldkit/url";

import { Message as AccountMessage } from "../src/client/account/message.js";
import { SessionState } from "../src/client/account/model.js";
import { application } from "../src/client/application.js";
import { Message } from "../src/client/board/message.js";
import { Preload } from "../src/client/board/model.js";
import type { ModelValue } from "../src/client/board/model.js";
import { init, update } from "../src/client/board/update.js";
import { Message as ConnectMessage } from "../src/client/connect/message.js";
import { ClientName, ConnectState } from "../src/client/connect/model.js";
import { Route, routeOfUrl } from "../src/client/route.js";

const ada = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "",
});

const flags = { origin: "https://jobs.example", preload: Preload.Nothing() };

const urlAt = (path: string) =>
  Option.getOrThrow(fromString(`https://jobs.example${path}`));

const authorizeParams = {
  client_id: "client-1",
  code_challenge: "challenge",
  code_challenge_method: "S256",
  redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
  resource: "https://jobs.example/mcp",
  response_type: "code",
  scope: "mcp offline_access",
  state: "state-1",
};

const signedSearch = new URLSearchParams({
  ...authorizeParams,
  ba_iat: "1",
  exp: "2",
  prompt: "login",
  sig: "signature",
});

for (const name of [
  ...Object.keys(authorizeParams),
  "prompt",
  "ba_iat",
  "exp",
]) {
  signedSearch.append("ba_param", name);
}

const connectPath = `/account/connect?${signedSearch}`;

const authorizePath = `/api/auth/oauth2/authorize?${new URLSearchParams(authorizeParams)}`;

interface Step {
  readonly commands: readonly {
    readonly args?: unknown;
    readonly name: string;
  }[];
  readonly model: ModelValue;
}

const sent = (step: Step, message: typeof Message.Type): Step => {
  const { commands = [], model } = update(step.model, message);

  return { commands, model };
};

const opened = (path: string): Step => {
  const { commands = [], model } = init(flags, urlAt(path));

  return { commands, model };
};

const withSession = (step: Step, account: Option.Option<typeof ada>) =>
  sent(
    step,
    Message.GotAccountMessage({
      message: AccountMessage.CompletedFetchSession({ account }),
    })
  );

const connectSent = (step: Step, message: typeof ConnectMessage.Type) =>
  sent(step, Message.GotConnectMessage({ message }));

const consentTextFor = (name: string, redirectHost: string) =>
  renderToString(
    {
      ...application,
      init: (...args: Parameters<typeof application.init>) => {
        const started = application.init(...args);

        return {
          ...started,
          model: {
            ...started.model,
            account: {
              ...started.model.account,
              session: SessionState.SignedIn({ account: ada }),
            },
            connect: {
              state: ConnectState.Ready({
                client: ClientName.Named({ name }),
                request: {
                  authorizePath,
                  clientId: "client-1",
                  redirectHost,
                  signed: signedSearch.toString(),
                },
              }),
            },
          },
        };
      },
    },
    { flags, url: `https://jobs.example${connectPath}` }
  ).pipe(
    Effect.map(({ html }) =>
      html.replaceAll(/<[^>]+>/gu, " ").replaceAll(/\s+/gu, " ")
    )
  );

const namesOf = (step: Step) => step.commands.map(({ name }) => name);

describe("connect an app", () => {
  it("opens the connect page for a signed authorization request", () => {
    expect(routeOfUrl(urlAt(connectPath))).toStrictEqual(Route.Connect());
  });

  it("signs a visitor in on the way back to the authorization request, without its signature or a login prompt", () => {
    const signedOut = withSession(opened(connectPath), Option.none());

    expect(signedOut.model.account.returnPath).toBe(authorizePath);

    const typed = sent(
      signedOut,
      Message.GotAccountMessage({
        message: AccountMessage.UpdatedSignInEmail({
          value: "ada@example.com",
        }),
      })
    );

    const submitted = sent(
      typed,
      Message.GotAccountMessage({ message: AccountMessage.SubmittedSignIn() })
    );

    expect(
      submitted.commands.map(({ args, name }) => ({ args, name }))
    ).toStrictEqual([
      {
        args: { email: "ada@example.com", returnPath: authorizePath },
        name: "RequestLink",
      },
    ]);
  });

  it("looks up the app's name once the member is signed in", () => {
    const signedIn = withSession(opened(connectPath), Option.some(ada));

    expect(
      signedIn.commands
        .filter(({ name }) => name === "FetchConnectingClient")
        .map(({ args }) => args)
    ).toStrictEqual([{ clientId: "client-1" }]);
  });

  it("answers with the signed request exactly as the page received it", () => {
    const signedIn = withSession(opened(connectPath), Option.some(ada));
    const allowed = connectSent(signedIn, ConnectMessage.ClickedAllowConnect());

    expect(
      allowed.commands.map(({ args, name }) => ({ args, name }))
    ).toStrictEqual([
      {
        args: { accept: true, signed: signedSearch.toString() },
        name: "AnswerConnect",
      },
    ]);
    expect(
      namesOf(connectSent(allowed, ConnectMessage.ClickedDenyConnect()))
    ).toStrictEqual([]);
  });

  it("says the request expired when the answer fails", () => {
    const signedIn = withSession(opened(connectPath), Option.some(ada));

    const failed = connectSent(
      connectSent(signedIn, ConnectMessage.ClickedDenyConnect()),
      ConnectMessage.FailedAnswerConnect()
    );

    expect(Schema.is(ConnectState.Failed)(failed.model.connect.state)).toBe(
      true
    );
  });

  it("refuses a connect page with no signed request and keeps sign-in pointed at the account", () => {
    const bare = withSession(opened("/account/connect"), Option.none());

    expect(bare.model.connect.state).toStrictEqual(ConnectState.Invalid());
    expect(bare.model.account.returnPath).toBe("/account");
  });

  it("returns to /account after an emailed link unless it names a path on this site", () => {
    expect(
      routeOfUrl(
        urlAt(
          `/account/confirm?token=t1&next=${encodeURIComponent(authorizePath)}`
        )
      )
    ).toStrictEqual(Route.ConfirmSignIn({ next: authorizePath, token: "t1" }));

    for (const next of ["https://evil.example/", "//evil.example/"]) {
      expect(
        routeOfUrl(
          urlAt(`/account/confirm?token=t1&next=${encodeURIComponent(next)}`)
        )
      ).toStrictEqual(Route.ConfirmSignIn({ next: "/account", token: "t1" }));
    }
  });

  it.effect(
    "names the app by its verified return host and marks its own name as unverified",
    () =>
      Effect.gen(function* consent() {
        const text = yield* consentTextFor("ChatGPT", "attacker.example");

        expect(text).toContain("Connect attacker.example to Gate Change");
        expect(text).not.toContain("Connect ChatGPT");
        expect(text).toContain("Returns to attacker.example");
        expect(text).toContain("Calls itself ChatGPT");
        expect(text).toContain("Gate Change has not checked it");
      })
  );
});
