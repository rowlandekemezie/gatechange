import { Schema } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import {
  boardMasthead,
  boardPage,
  boardTitle,
} from "../../features/board/view.js";
import { jobPage, jobTitle } from "../../features/job/view.js";
import { shortlistPage } from "../../features/shortlist/view.js";
import { boardUrl, Route, shortlistRouter } from "../route.js";
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

const footer = (h: H): Html =>
  h.footer(
    [h.Class("footer")],
    [
      h.p(
        [],
        [
          "Roles come from public company job boards on Greenhouse, Lever and Ashby, and from ",
          h.a([h.Href("https://remoteok.com")], ["Remote OK"]),
          ", ",
          h.a([h.Href("https://remotive.com")], ["Remotive"]),
          ", ",
          h.a([h.Href("https://himalayas.app")], ["Himalayas"]),
          ", ",
          h.a([h.Href("https://jobicy.com")], ["Jobicy"]),
          " and the monthly Hacker News hiring thread. Each listing links to its original posting. Roles leave the board when their source removes them or after 30 days.",
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

export const view = (model: ModelValue, h: H): Document => ({
  body: h.main(
    [h.Class("page")],
    [
      ...(Schema.is(Route.Board)(model.route) ? [boardMasthead(model, h)] : []),
      tabs(model, h),
      Route.match<Html>(model.route, {
        Board: () => boardPage(model, h),
        Job: () => jobPage(model, h),
        NotFound: () => notFoundPage(model, h),
        Shortlist: () => shortlistPage(model, h),
      }),
      footer(h),
    ]
  ),
  title: Route.match<string>(model.route, {
    Board: () => boardTitle(model),
    Job: () => jobTitle(model),
    NotFound: () => "Page not found",
    Shortlist: () => `Your shortlist (${model.marks.length})`,
  }),
});
