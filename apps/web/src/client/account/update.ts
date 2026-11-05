import { Option, Schema } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { JobQueries } from "../board/queries.js";
import type { AuthClient } from "./auth-client.js";
import {
  FetchSession,
  FetchSignInOptions,
  PreviewLink,
  RequestLink,
  SignOut,
  StartSocialSignIn,
} from "./command.js";
import { Message } from "./message.js";
import type { MessageValue } from "./message.js";
import { editing, LinkPreview, SessionState, SignInState } from "./model.js";
import type { LinkOutcomeValue, ModelValue } from "./model.js";

type UpdateReturn = Update.Return<
  ModelValue,
  MessageValue,
  JobQueries | AuthClient
>;

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const providerName = { github: "GitHub", google: "Google" } as const;

const linkProblems: Record<Exclude<LinkOutcomeValue, "Sent">, string> = {
  Failed: "We could not send the link. Try again in a minute.",
  Invalid: "That email address does not look right. Check it and try again.",
  Limited:
    "We cannot send another sign-in link right now. Use the newest one, or try again later.",
};

const typedEmail = (model: ModelValue) =>
  SignInState.match<string>(model.signIn, {
    Editing: ({ email }) => email,
    Sending: ({ email }) => email,
    Sent: ({ email }) => email,
  });

export const init = (): UpdateReturn => ({
  commands: [FetchSession()],
  model: {
    link: LinkPreview.Checking(),
    session: SessionState.Checking(),
    signIn: editing(""),
    socialProviders: [],
  },
});

export const entered = (model: ModelValue): UpdateReturn =>
  Schema.is(SessionState.SignedIn)(model.session)
    ? { model }
    : { commands: [FetchSignInOptions()], model };

export const enteredConfirm =
  (token: string) =>
  (model: ModelValue): UpdateReturn => ({
    commands: [PreviewLink({ token })],
    model: modifyFields(model, { link: () => LinkPreview.Checking() }),
  });

const submitted = (model: ModelValue): UpdateReturn => {
  if (!Schema.is(SignInState.Editing)(model.signIn)) {
    return { model };
  }

  const email = model.signIn.email.trim();

  if (!EMAIL_ADDRESS.test(email)) {
    return {
      model: modifyFields(model, {
        signIn: () =>
          editing(email, "Enter an email address like you@company.com."),
      }),
    };
  }

  return {
    commands: [RequestLink({ email })],
    model: modifyFields(model, {
      signIn: () => SignInState.Sending({ email }),
    }),
  };
};

export const update = (
  model: ModelValue,
  message: MessageValue
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedRetryLinkCheck: ({ token }) => enteredConfirm(token)(model),
    ClickedSignOut: () => ({ commands: [SignOut()], model }),
    ClickedSocialSignIn: ({ provider }) => ({
      commands: [StartSocialSignIn({ provider })],
      model,
    }),
    ClickedUseAnotherEmail: () => ({
      model: modifyFields(model, { signIn: () => editing(typedEmail(model)) }),
    }),
    CompletedFetchSession: ({ account }) => ({
      model: modifyFields(model, {
        session: () =>
          Option.match(account, {
            onNone: () => SessionState.SignedOut(),
            onSome: (found) => SessionState.SignedIn({ account: found }),
          }),
      }),
    }),
    CompletedFetchSignInOptions: ({ socialProviders }) => ({
      model: modifyFields(model, { socialProviders: () => socialProviders }),
    }),
    CompletedPreviewLink: ({ preview }) => ({
      model: modifyFields(model, { link: () => preview }),
    }),
    CompletedRequestLink: ({ email, outcome }) => ({
      model: modifyFields(model, {
        signIn: () => {
          if (outcome === "Sent") {
            return SignInState.Sent({ email });
          }

          return editing(email, linkProblems[outcome]);
        },
      }),
    }),
    CompletedSignOut: () => ({
      commands: [FetchSession(), FetchSignInOptions()],
      model: modifyFields(model, {
        session: () => SessionState.Checking(),
        signIn: () => editing(""),
      }),
    }),
    CompletedSocialRedirect: () => ({ model }),
    FailedSocialSignIn: ({ provider }) => ({
      model: modifyFields(model, {
        signIn: () =>
          editing(
            typedEmail(model),
            `We could not start ${providerName[provider]} sign-in. Try again.`
          ),
      }),
    }),
    SubmittedSignIn: () => submitted(model),
    UpdatedSignInEmail: ({ value }) => ({
      model: Schema.is(SignInState.Editing)(model.signIn)
        ? modifyFields(model, { signIn: () => editing(value) })
        : model,
    }),
  });
