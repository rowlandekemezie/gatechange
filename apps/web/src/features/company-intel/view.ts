import type { CompanySummaryValue } from "@rat-stack/core/contracts";
import { Match } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { isFreeViewer } from "../../client/billing/model.js";
import type { MessageValue } from "../../client/board/message.js";
import type { ModelValue } from "../../client/board/model.js";
import { pricingRouter } from "../../client/route.js";

type H = HtmlBuilder<MessageValue>;

const days = (count: number) =>
  Match.value(count).pipe(
    Match.when(0, () => "under a day"),
    Match.when(1, () => "1 day"),
    Match.orElse(() => `${count} days`)
  );

export const summaryText = ({
  longestOpenDays,
  openRoles,
}: CompanySummaryValue) =>
  openRoles === 1
    ? `1 open leadership role, listed for ${days(longestOpenDays)}.`
    : `${openRoles} open leadership roles. The longest has been listed for ${days(longestOpenDays)}.`;

const teaser = (h: H): Html =>
  h.p(
    [h.Class("upgrade-prompt intel-teaser")],
    [
      "Pro shows how long each role has been open, how often it was reposted, a 90-day hiring trend, and typical salary bands. ",
      h.a([h.Href(pricingRouter())], ["See Pro plans"]),
    ]
  );

export const companyIntelSection = (
  model: ModelValue,
  h: H,
  company: string,
  summary: CompanySummaryValue
): Html =>
  h.section(
    [h.Class("intel"), h.AriaLabel(`Hiring at ${company}`)],
    [
      h.h2([h.Class("intel-title")], [`Hiring at ${company}`]),
      h.p([h.Class("intel-summary")], [summaryText(summary)]),
      ...(isFreeViewer(model.account.session, model.billing)
        ? [teaser(h)]
        : []),
    ]
  );
