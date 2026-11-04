import { MAGIC_LINK_TTL_MINUTES } from "@rat-stack/core/contracts";
import type { SocialProviderValue } from "@rat-stack/core/contracts";
import { Option, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineView } from "foldkit/submodel";

import { Message } from "../../client/account/message.js";
import type { MessageValue } from "../../client/account/message.js";
import {
  LinkPreview,
  SessionState,
  SignInState,
} from "../../client/account/model.js";
import type {
  ModelValue,
  SessionStateValue,
} from "../../client/account/model.js";
import { accountRouter, informationRouter } from "../../client/route.js";
import type { AccountNoticeValue } from "../../client/route.js";

interface AccountViewInputs {
  readonly notice: AccountNoticeValue;
}

const AUTH_RETURN_PATH = "/account";

const noticeText: Partial<Record<AccountNoticeValue, string>> = {
  LinkRefused:
    "That sign-in link has expired or was already used. Ask for a new one below.",
  SignInFailed: "Sign-in did not finish. Try again below.",
};

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
      h.Class("nav-link nav-account"),
      h.Href(accountRouter({ notice: "None" })),
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

const noticeNote = (
  h: HtmlBuilder<MessageValue>,
  model: ModelValue,
  notice: AccountNoticeValue
): readonly Html[] =>
  Option.match(Option.fromNullishOr(noticeText[notice]), {
    onNone: () => [],
    onSome: (text) =>
      Schema.is(SignInState.Editing)(model.signIn)
        ? [h.p([h.Class("sign-in-problem"), h.Role("alert")], [text])]
        : [],
  });

const confirmForm = <M>(
  token: string,
  label: string,
  h: HtmlBuilder<M>
): Html =>
  h.form(
    [h.Action("/api/auth/magic-link/verify"), h.Method("get")],
    [
      h.input([h.Type("hidden"), h.Name("token"), h.Value(token)]),
      h.input([
        h.Type("hidden"),
        h.Name("callbackURL"),
        h.Value(AUTH_RETURN_PATH),
      ]),
      h.input([
        h.Type("hidden"),
        h.Name("errorCallbackURL"),
        h.Value(AUTH_RETURN_PATH),
      ]),
      h.button([h.Type("submit"), h.Class("search-button")], [label]),
    ]
  );

const browserNote = <M>(h: HtmlBuilder<M>): Html =>
  h.p(
    [h.Class("account-lede")],
    [
      "Signing in needs an up-to-date browser: Safari 16.4 or later, Firefox 90 or later, or a current Chrome or Edge. On an older browser, open the link from your email in one of these.",
    ]
  );

const namedLinkBody = <M>(
  token: string,
  email: string,
  session: SessionStateValue,
  h: HtmlBuilder<M>
): readonly Html[] =>
  SessionState.match<readonly Html[]>(session, {
    Checking: () => [
      h.p([h.Class("status"), h.Role("status")], ["Checking your session…"]),
    ],
    SignedIn: ({ account }) =>
      account.email.toLowerCase() === email.toLowerCase()
        ? [
            h.p(
              [h.Class("account-lede")],
              [`You are already signed in as ${email}.`]
            ),
            h.p([], [h.a([h.Href(AUTH_RETURN_PATH)], ["Go to your account"])]),
          ]
        : [
            h.p(
              [h.Class("sign-in-problem"), h.Role("alert")],
              [
                `You are signed in as ${account.email}. This link opens a different account, ${email}. Anything you save after switching goes to ${email}.`,
              ]
            ),
            h.p(
              [],
              [
                h.a(
                  [h.Href(AUTH_RETURN_PATH)],
                  [`Stay signed in as ${account.email}`]
                ),
              ]
            ),
            confirmForm(token, `Switch to ${email}`, h),
            browserNote(h),
          ],
    SignedOut: () => [
      h.p(
        [h.Class("account-lede")],
        [
          `This link signs you in as ${email}. If that is not your email address, close this page. The link works once.`,
        ]
      ),
      confirmForm(token, "Finish signing in", h),
      browserNote(h),
    ],
  });

export const confirmSignInPage = <M>(
  token: string,
  { link, session }: ModelValue,
  h: HtmlBuilder<M>
): Html =>
  h.div(
    [h.Class("detail account")],
    [
      h.h1([h.Class("detail-title")], ["Finish signing in"]),
      ...LinkPreview.match<readonly Html[]>(link, {
        Checking: () => [
          h.p([h.Class("status"), h.Role("status")], ["Checking this link…"]),
        ],
        Named: ({ email }) => namedLinkBody(token, email, session, h),
        Refused: () => [
          h.p(
            [h.Class("sign-in-problem"), h.Role("alert")],
            ["This sign-in link has expired or has already been used."]
          ),
          h.p([], [h.a([h.Href(AUTH_RETURN_PATH)], ["Request a new link"])]),
        ],
        Unknown: () => [
          h.p(
            [h.Class("sign-in-problem"), h.Role("alert")],
            [
              "We could not check this link. Open the link from your email again.",
            ]
          ),
        ],
      }),
    ]
  );

export const accountView = defineView<
  ModelValue,
  MessageValue,
  AccountViewInputs
>((model, { notice }, h) =>
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
          h.p(
            [],
            [
              h.a(
                [h.Href(informationRouter("Contact"))],
                ["Account help or deletion request"]
              ),
            ]
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
          ...noticeNote(h, model, notice),
          ...signInPanel(model, h),
        ]
      ),
  })
);

export const accountTitle = (session: SessionStateValue): string =>
  Schema.is(SessionState.SignedIn)(session) ? "Your account" : "Sign in";
