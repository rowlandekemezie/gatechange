import { isPro } from "@rat-stack/core/contracts";
import { Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineView } from "foldkit/submodel";

import { SessionState } from "../../client/account/model.js";
import type { SessionStateValue } from "../../client/account/model.js";
import { MembershipState } from "../../client/billing/model.js";
import type { MembershipStateValue } from "../../client/billing/model.js";
import { Message } from "../../client/connect/message.js";
import type { MessageValue } from "../../client/connect/message.js";
import { ClientName, ConnectState } from "../../client/connect/model.js";
import type {
  ClientNameValue,
  ConnectRequestValue,
  ModelValue,
} from "../../client/connect/model.js";
import { pricingRouter } from "../../client/route.js";

interface ConnectViewInputs {
  readonly membership: MembershipStateValue;
  readonly session: SessionStateValue;
}

const appNameOf = (client: ClientNameValue) =>
  ClientName.match<string>(client, {
    Loading: () => "An app",
    Named: ({ name }) => name,
    NotAsked: () => "An app",
    Unnamed: () => "An app",
  });

const title = (h: HtmlBuilder<MessageValue>, text: string): Html =>
  h.h1([h.Class("detail-title")], [text]);

const passOf = (
  h: HtmlBuilder<MessageValue>,
  client: ClientNameValue,
  request: ConnectRequestValue
): Html =>
  h.dl(
    [h.Class("connect-pass")],
    [
      h.dt([], ["App"]),
      h.dd([], [appNameOf(client)]),
      h.dt([], ["Returns to"]),
      h.dd([], [request.redirectHost]),
    ]
  );

const proNote = (
  h: HtmlBuilder<MessageValue>,
  membership: MembershipStateValue
): readonly Html[] =>
  Schema.is(MembershipState.Loaded)(membership) &&
  !isPro(membership.membership.entitlement)
    ? [
        h.p(
          [h.Class("sign-in-problem"), h.Role("alert")],
          [
            "Your account does not have Pro. The app can connect, but Gate Change will refuse its requests until you ",
            h.a([h.Href(pricingRouter())], ["subscribe to Pro"]),
            ".",
          ]
        ),
      ]
    : [];

const answerButtons = (
  h: HtmlBuilder<MessageValue>,
  answering?: boolean
): Html =>
  h.div(
    [h.Class("detail-actions")],
    [
      h.button(
        [
          h.Type("button"),
          h.Class("search-button"),
          h.Disabled(answering !== undefined),
          h.OnClick(Message.ClickedAllowConnect()),
        ],
        [answering === true ? "Connecting…" : "Allow"]
      ),
      h.button(
        [
          h.Type("button"),
          h.Class("more"),
          h.Disabled(answering !== undefined),
          h.OnClick(Message.ClickedDenyConnect()),
        ],
        [answering === false ? "Declining…" : "Deny"]
      ),
    ]
  );

const consentBody = (
  h: HtmlBuilder<MessageValue>,
  email: string,
  membership: MembershipStateValue,
  client: ClientNameValue,
  request: ConnectRequestValue,
  answering?: boolean
): readonly Html[] => [
  title(h, `Connect ${appNameOf(client)} to Gate Change`),
  h.p(
    [h.Class("account-lede")],
    [
      "This app is asking to use your account through the Gate Change agent tools. It will be able to search the board, manage your saved searches, and read and change your application tracker.",
    ]
  ),
  passOf(h, client, request),
  h.p([h.Class("account-email")], [`Signed in as ${email}`]),
  ...proNote(h, membership),
  answerButtons(h, answering),
];

const invalidBody = (h: HtmlBuilder<MessageValue>): readonly Html[] => [
  title(h, "Connect an app"),
  h.p(
    [h.Class("sign-in-problem"), h.Role("alert")],
    [
      "This page needs a connection request from an app. Start connecting from the app you want to use with Gate Change.",
    ]
  ),
];

const signedInBody = (
  model: ModelValue,
  email: string,
  membership: MembershipStateValue,
  h: HtmlBuilder<MessageValue>
): readonly Html[] =>
  ConnectState.match<readonly Html[]>(model.state, {
    Answering: ({ accept, client, request }) =>
      consentBody(h, email, membership, client, request, accept),
    Failed: ({ client }) => [
      title(h, `Connect ${appNameOf(client)} to Gate Change`),
      h.p(
        [h.Class("sign-in-problem"), h.Role("alert")],
        [
          "This connection request has expired or was already answered. Start connecting again from the app.",
        ]
      ),
    ],
    Invalid: () => invalidBody(h),
    Ready: ({ client, request }) =>
      consentBody(h, email, membership, client, request),
  });

const signedOutBody = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): readonly Html[] =>
  Schema.is(ConnectState.Invalid)(model.state)
    ? invalidBody(h)
    : [
        title(h, "Sign in to connect an app"),
        h.p(
          [h.Class("account-lede")],
          [
            "Sign in to your Gate Change account first. You will come back here to allow or deny the connection.",
          ]
        ),
      ];

export const connectView = defineView<
  ModelValue,
  MessageValue,
  ConnectViewInputs
>((model, { membership, session }, h) =>
  h.div(
    [h.Class("detail account")],
    SessionState.match<readonly Html[]>(session, {
      Checking: () => [
        h.p([h.Class("status"), h.Role("status")], ["Checking your session…"]),
      ],
      SignedIn: ({ account }) =>
        signedInBody(model, account.email, membership, h),
      SignedOut: () => signedOutBody(model, h),
    })
  )
);
