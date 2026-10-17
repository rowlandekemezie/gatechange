import { MAGIC_LINK_TTL_MINUTES } from "@rat-stack/core/contracts";
import type { SocialProviderValue } from "@rat-stack/core/contracts";
import { Option, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineView } from "foldkit/submodel";

import { Message } from "../../client/account/message.js";
import type { MessageValue } from "../../client/account/message.js";
import { SessionState, SignInState } from "../../client/account/model.js";
import type {
  ModelValue,
  SessionStateValue,
} from "../../client/account/model.js";
import { accountRouter } from "../../client/route.js";

interface AccountViewInputs {
  readonly linkRefused: boolean;
}

const providerLabel: Record<SocialProviderValue, string> = {
  github: "Continue with GitHub",
  google: "Continue with Google",
};

const PROBLEM_ID = "sign-in-problem";

export const sessionLink = <M>(
  session: SessionStateValue,
  isCurrent: boolean,
  h: HtmlBuilder<M>
): Html =>
  h.a(
    [
      h.Class(isCurrent ? "tab tab-on account-tab" : "tab account-tab"),
      h.Href(accountRouter({ linkRefused: false })),
      ...(isCurrent ? [h.AriaCurrent("page")] : []),
    ],
    [
      SessionState.match<string>(session, {
        Checking: () => "Sign in",
        SignedIn: ({ account }) => account.email,
        SignedOut: () => "Sign in",
      }),
    ]
  );

const problemNote = (
  h: HtmlBuilder<MessageValue>,
  problem: Option.Option<string>
): readonly Html[] =>
  Option.match(problem, {
    onNone: () => [],
    onSome: (text) => [
      h.p(
        [h.Id(PROBLEM_ID), h.Class("sign-in-problem"), h.Role("alert")],
        [text]
      ),
    ],
  });

const emailForm = (
  h: HtmlBuilder<MessageValue>,
  email: string,
  problem: Option.Option<string>,
  isSending: boolean
): Html =>
  h.form(
    [
      h.Class("sign-in"),
      h.Novalidate(true),
      h.OnSubmit(Message.SubmittedSignIn()),
    ],
    [
      h.label([h.For("sign-in-email")], ["Email address"]),
      h.div(
        [h.Class("sign-in-row")],
        [
          h.input([
            h.Id("sign-in-email"),
            h.Type("email"),
            h.Name("email"),
            h.Value(email),
            h.Autocomplete("email"),
            h.Placeholder("you@company.com"),
            h.AriaInvalid(Option.isSome(problem)),
            ...(Option.isSome(problem) ? [h.AriaDescribedBy(PROBLEM_ID)] : []),
            h.OnInput((value) => Message.UpdatedSignInEmail({ value })),
          ]),
          h.button(
            [h.Type("submit"), h.Class("search-button"), h.Disabled(isSending)],
            [isSending ? "Sending…" : "Email me a link"]
          ),
        ]
      ),
      ...problemNote(h, problem),
    ]
  );

const socialButtons = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): readonly Html[] =>
  model.socialProviders.length === 0
    ? []
    : [
        h.div(
          [h.Class("sign-in-social")],
          model.socialProviders.map((provider) =>
            h.button(
              [
                h.Type("button"),
                h.Class("more"),
                h.OnClick(Message.ClickedSocialSignIn({ provider })),
              ],
              [providerLabel[provider]]
            )
          )
        ),
      ];

const signInPanel = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): readonly Html[] =>
  SignInState.match<readonly Html[]>(model.signIn, {
    Editing: ({ email, problem }) => [
      emailForm(h, email, problem, false),
      ...socialButtons(model, h),
    ],
    Sending: ({ email }) => [emailForm(h, email, Option.none(), true)],
    Sent: ({ email }) => [
      h.div(
        [h.Class("sign-in-sent"), h.Role("status")],
        [
          h.p(
            [],
            [
              `Check ${email} for a sign-in link. It works once and expires in ${MAGIC_LINK_TTL_MINUTES} minutes.`,
            ]
          ),
          h.button(
            [
              h.Type("button"),
              h.Class("mark"),
              h.OnClick(Message.ClickedUseAnotherEmail()),
            ],
            ["Use a different email"]
          ),
        ]
      ),
    ],
  });

const refusedNotice = (
  h: HtmlBuilder<MessageValue>,
  linkRefused: boolean
): readonly Html[] =>
  linkRefused
    ? [
        h.p(
          [h.Class("sign-in-problem"), h.Role("alert")],
          [
            "That sign-in link has expired or was already used. Ask for a new one below.",
          ]
        ),
      ]
    : [];

export const accountView = defineView<
  ModelValue,
  MessageValue,
  AccountViewInputs
>((model, { linkRefused }, h) =>
  SessionState.match<Html>(model.session, {
    Checking: () =>
      h.div(
        [h.Class("detail account")],
        [h.p([h.Class("status"), h.Role("status")], ["Checking your session…"])]
      ),
    SignedIn: ({ account }) =>
      h.div(
        [h.Class("detail account")],
        [
          h.h1([h.Class("detail-title")], ["Your account"]),
          h.p([h.Class("account-email")], [`Signed in as ${account.email}`]),
          h.button(
            [
              h.Type("button"),
              h.Class("more"),
              h.OnClick(Message.ClickedSignOut()),
            ],
            ["Sign out"]
          ),
        ]
      ),
    SignedOut: () =>
      h.div(
        [h.Class("detail account")],
        [
          h.h1([h.Class("detail-title")], ["Sign in"]),
          h.p(
            [h.Class("account-lede")],
            [
              "We email you a link that signs you in. There is no password to remember.",
            ]
          ),
          ...refusedNotice(h, linkRefused),
          ...signInPanel(model, h),
        ]
      ),
  })
);

export const accountTitle = (session: SessionStateValue): string =>
  Schema.is(SessionState.SignedIn)(session) ? "Your account" : "Sign in";
