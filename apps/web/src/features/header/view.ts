import { SITE_NAME, SOURCE_REPOSITORY_URL } from "@rat-stack/core/contracts";
import { Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { shortlistSize } from "../../client/board/marks.js";
import type { MessageValue } from "../../client/board/message.js";
import type { ModelValue } from "../../client/board/model.js";
import { boardUrl, Route, shortlistRouter } from "../../client/route.js";
import { sessionLink } from "../account/view.js";
import { planLink } from "../pricing/view.js";

type H = HtmlBuilder<MessageValue>;

const navLink = (h: H, href: string, isCurrent: boolean, label: string) =>
  h.a(
    [
      h.Class("nav-link"),
      h.Href(href),
      ...(isCurrent ? [h.AriaCurrent("page")] : []),
    ],
    [label]
  );

const loopMark = (h: H): Html =>
  h.span(
    [h.Class("brand-mark"), h.AriaHidden(true)],
    [
      h.svg(
        [h.ViewBox("0 0 22 22"), h.Width("22"), h.Height("22")],
        [
          h.path(
            [
              h.D(
                "M5 8a3.5 3.5 0 1 0 0 7c2 0 3-1.5 6-3.5s4-3.5 6-3.5a3.5 3.5 0 1 1 0 7c-2 0-3-1.5-6-3.5S7 8 5 8Z"
              ),
              h.Fill("none"),
              h.Stroke("currentColor"),
              h.StrokeWidth("2.2"),
            ],
            []
          ),
        ]
      ),
    ]
  );

const menuIcon = (h: H): Html =>
  h.svg(
    [h.ViewBox("0 0 20 20"), h.Width("20"), h.Height("20"), h.AriaHidden(true)],
    [
      h.path(
        [
          h.D("M3 6h14M3 10h14M3 14h14"),
          h.Stroke("currentColor"),
          h.StrokeWidth("2"),
          h.StrokeLinecap("round"),
        ],
        []
      ),
    ]
  );

const navItems = (model: ModelValue, h: H): readonly Html[] => [
  navLink(
    h,
    boardUrl(model.filters),
    Schema.is(Route.Board)(model.route),
    "Roles"
  ),
  navLink(h, `${boardUrl(model.filters)}#agents`, false, "For agents"),
  planLink(
    model.billing,
    model.account.session,
    Schema.is(Route.Pricing)(model.route),
    h
  ),
  navLink(h, SOURCE_REPOSITORY_URL, false, "GitHub"),
  navLink(
    h,
    shortlistRouter(),
    Schema.is(Route.Shortlist)(model.route),
    `Shortlist (${shortlistSize(model)})`
  ),
  sessionLink(model.account.session, Schema.is(Route.Account)(model.route), h),
];

export const siteHeader = (model: ModelValue, h: H): Html =>
  h.header(
    [h.Class("site-header")],
    [
      h.a(
        [h.Class("brand"), h.Href(boardUrl(model.filters))],
        [loopMark(h), h.span([h.Class("brand-name")], [SITE_NAME])]
      ),
      h.nav([h.Class("site-nav"), h.AriaLabel("Site")], navItems(model, h)),
      h.keyed("details")(
        model.route._tag,
        [h.Class("site-menu")],
        [
          h.summary(
            [h.Class("site-menu-button"), h.AriaLabel("Menu")],
            [menuIcon(h)]
          ),
          h.nav(
            [h.Class("site-menu-nav"), h.AriaLabel("Site menu")],
            navItems(model, h)
          ),
        ]
      ),
    ]
  );
