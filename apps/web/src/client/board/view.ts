import { SourceName, SourceTerms } from "@rat-stack/core/contracts";
import type { SourceTermsValue } from "@rat-stack/core/contracts";
import { Option, Schema } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import {
  boardMasthead,
  boardPage,
  boardTitle,
} from "../../features/board/view.js";
import { jobPage, jobTitle } from "../../features/job/view.js";
import { listingPage, listingTitle } from "../../features/listing/view.js";
import { shortlistPage } from "../../features/shortlist/view.js";
import { boardUrl, canonicalPathOf, Route, shortlistRouter } from "../route.js";
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
        `Your shortlist (${model.marks.length})`
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
        Route.match<Html>(model.route, {
          Board: () => boardPage(model, h),
          Company: () => listingPage(model, h),
          Job: () => jobPage(model, h),
          NotFound: () => notFoundPage(model, h),
          Role: () => listingPage(model, h),
          Shortlist: () => shortlistPage(model, h),
        }),
        footer(h),
      ]
    ),
    title: Route.match<string>(model.route, {
      Board: () => boardTitle(model),
      Company: () => listingTitle(model),
      Job: () => jobTitle(model),
      NotFound: () => "Page not found",
      Role: () => listingTitle(model),
      Shortlist: () => `Your shortlist (${model.marks.length})`,
    }),
  });
