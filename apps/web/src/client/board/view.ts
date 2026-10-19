import { SourceName, SourceTerms } from "@rat-stack/core/contracts";
import type { SourceTermsValue } from "@rat-stack/core/contracts";
import { Option, Schema } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import {
  accountTitle,
  accountView,
  confirmSignInPage,
  sessionLink,
} from "../../features/account/view.js";
import { agentTokensPanel } from "../../features/agent-tokens/view.js";
import {
  boardMasthead,
  boardPage,
  boardTitle,
} from "../../features/board/view.js";
import { jobPage, jobTitle } from "../../features/job/view.js";
import { listingPage, listingTitle } from "../../features/listing/view.js";
import {
  billingPanel,
  planLink,
  pricingPage,
} from "../../features/pricing/view.js";
import { savedSearchesPanel } from "../../features/saved-searches/view.js";
import {
  shortlistPage,
  trackerNotices,
} from "../../features/shortlist/view.js";
import { SessionState } from "../account/model.js";
import { boardUrl, canonicalPathOf, Route, shortlistRouter } from "../route.js";
import { shortlistSize } from "./marks.js";
import { Message } from "./message.js";
import type { MessageValue } from "./message.js";
import type { ModelValue } from "./model.js";

type H = HtmlBuilder<MessageValue>;

const tab = (h: H, href: string, isOn: boolean, label: string): Html =>
  h.a(
    [
      h.Href(href),
      h.Class(isOn ? "tab tab-on" : "tab"),
      ...(isOn ? [h.AriaCurrent("page")] : []),
    ],
    [label]
  );

const tabs = (model: ModelValue, h: H): Html =>
  h.nav(
    [h.Class("tabs"), h.AriaLabel("Views")],
    [
      tab(
        h,
        boardUrl(model.filters),
        Schema.is(Route.Board)(model.route),
        "Open roles"
      ),
      tab(
        h,
        shortlistRouter(),
        Schema.is(Route.Shortlist)(model.route),
        `Your shortlist (${shortlistSize(model)})`
      ),
      planLink(
        model.billing,
        model.account.session,
        Schema.is(Route.Pricing)(model.route),
        h
      ),
      sessionLink(
        model.account.session,
        Schema.is(Route.Account)(model.route),
        h
      ),
    ]
  );

const notFoundPage = (model: ModelValue, h: H): Html =>
  h.div(
    [h.Class("empty detail"), h.Role("alert")],
    [
      h.h1([h.Class("detail-title")], ["There is no page here"]),
      h.a(
        [h.Class("back"), h.Href(boardUrl(model.filters))],
        ["Back to open roles"]
      ),
    ]
  );

const sourcesOf = (kind: SourceTermsValue["kind"]) =>
  SourceName.literals
    .map((source) => SourceTerms[source])
    .filter((terms) => terms.kind === kind);

const creditList = (items: readonly (Html | string)[]) =>
  items.flatMap((item, index) => {
    if (index === 0) {
      return [item];
    }

    return [index === items.length - 1 ? " and " : ", ", item];
  });

const footer = (h: H): Html =>
  h.footer(
    [h.Class("footer")],
    [
      h.p(
        [],
        [
          "Roles come from public company job boards on ",
          ...creditList(sourcesOf("CompanyBoard").map(({ label }) => label)),
          ", and from ",
          ...creditList(
            sourcesOf("Aggregator").map(({ creditUrl, label }) =>
              h.a([h.Href(creditUrl)], [label])
            )
          ),
          ". Each listing links to its original posting. Roles leave the board when their source removes them or after 30 days.",
        ]
      ),
      h.p(
        [],
        [
          h.a(
            [h.Href("https://rowlandekemezie.com")],
            ["Made by Rowland Ekemezie"]
          ),
        ]
      ),
    ]
  );

const withCanonical = (model: ModelValue, document: Document): Document =>
  Option.match(canonicalPathOf(model.route), {
    onNone: () => document,
    onSome: (path) => ({ ...document, canonical: `${model.origin}${path}` }),
  });

export const view = (model: ModelValue, h: H): Document =>
  withCanonical(model, {
    body: h.main(
      [h.Class("page")],
      [
        ...(Schema.is(Route.Board)(model.route)
          ? [boardMasthead(model, h)]
          : []),
        tabs(model, h),
        ...trackerNotices(model, h),
        Route.match<Html>(model.route, {
          Account: ({ notice }) =>
            h.div(
              [h.Class("account-page")],
              [
                h.submodel({
                  model: model.account,
                  slotId: "account",
                  toParentMessage: (message) =>
                    Message.GotAccountMessage({ message }),
                  view: accountView,
                  viewInputs: { notice },
                }),
                ...(Schema.is(SessionState.SignedIn)(model.account.session)
                  ? [
                      h.submodel({
                        model: model.billing,
                        slotId: "billing",
                        toParentMessage: (message) =>
                          Message.GotBillingMessage({ message }),
                        view: billingPanel,
                        viewInputs: { notice },
                      }),
                      h.submodel({
                        model: model.savedSearches,
                        slotId: "saved-searches",
                        toParentMessage: (message) =>
                          Message.GotSavedSearchesMessage({ message }),
                        view: savedSearchesPanel,
                      }),
                      h.submodel({
                        model: model.agentTokens,
                        slotId: "agent-tokens",
                        toParentMessage: (message) =>
                          Message.GotAgentTokensMessage({ message }),
                        view: agentTokensPanel,
                        viewInputs: {
                          membership: model.billing.membership,
                          origin: model.origin,
                        },
                      }),
                    ]
                  : []),
              ]
            ),
          Board: () => boardPage(model, h),
          Company: () => listingPage(model, h),
          ConfirmSignIn: ({ token }) => confirmSignInPage(token, h),
          Job: () => jobPage(model, h),
          NotFound: () => notFoundPage(model, h),
          Pricing: () =>
            h.submodel({
              model: model.billing,
              slotId: "pricing",
              toParentMessage: (message) =>
                Message.GotBillingMessage({ message }),
              view: pricingPage,
              viewInputs: { session: model.account.session },
            }),
          Role: () => listingPage(model, h),
          Shortlist: () => shortlistPage(model, h),
        }),
        footer(h),
      ]
    ),
    title: Route.match<string>(model.route, {
      Account: () => accountTitle(model.account.session),
      Board: () => boardTitle(model),
      Company: () => listingTitle(model),
      ConfirmSignIn: () => "Finish signing in",
      Job: () => jobTitle(model),
      NotFound: () => "Page not found",
      Pricing: () => "Pro plans",
      Role: () => listingTitle(model),
      Shortlist: () => `Your shortlist (${shortlistSize(model)})`,
    }),
  });
