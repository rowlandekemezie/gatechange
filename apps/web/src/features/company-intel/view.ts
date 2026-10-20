import {
  paidFeaturesAllowed,
  SourceName,
  SourceTerms,
  TREND_WEEKS,
} from "@rat-stack/core/contracts";
import type {
  CompanyIntelValue,
  CompanySummaryValue,
  IntelRoleValue,
  TrendWeekValue,
  TypicalBandValue,
} from "@rat-stack/core/contracts";
import { Array, Match } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { isFreeViewer, isProMember } from "../../client/billing/model.js";
import { bandLabel } from "../../client/board/copy.js";
import { Message } from "../../client/board/message.js";
import type { MessageValue } from "../../client/board/message.js";
import { IntelState } from "../../client/board/model.js";
import type { ModelValue } from "../../client/board/model.js";
import { jobRouter, pricingRouter } from "../../client/route.js";

type H = HtmlBuilder<MessageValue>;

const days = (count: number) =>
  Match.value(count).pipe(
    Match.when(0, () => "under a day"),
    Match.when(1, () => "1 day"),
    Match.orElse(() => `${count} days`)
  );

const times = (count: number) =>
  Match.value(count).pipe(
    Match.when(0, () => "never reposted"),
    Match.when(1, () => "reposted once"),
    Match.orElse(() => `reposted ${count} times`)
  );

export const summaryText = ({
  longestOpenDays,
  openRoles,
}: CompanySummaryValue) =>
  openRoles === 1
    ? `1 open leadership role, listed for ${days(longestOpenDays)}.`
    : `${openRoles} open leadership roles. The longest has been listed for ${days(longestOpenDays)}.`;

const shortDate = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const longDate = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeZone: "UTC",
});

const excludedSources = SourceName.literals
  .filter((source) => !paidFeaturesAllowed(source))
  .map((source) => SourceTerms[source].label)
  .join(" and ");

export const trendText = (weeks: readonly TrendWeekValue[]) =>
  Array.match(weeks, {
    onEmpty: () => "",
    onNonEmpty: (all) => {
      const first = Array.headNonEmpty(all);
      const last = Array.lastNonEmpty(all);
      const peak = Math.max(...all.map((week) => week.open));

      return `Open leadership roles went from ${first.open} in the week ending ${shortDate.format(first.weekEnding)} to ${last.open} this week, with a peak of ${peak}, over ${all.length} weeks.`;
    },
  });

const WIDTH = 320;

const PLOT_LEFT = 34;

const PLOT_RIGHT = 312;

const PLOT_TOP = 18;

const PLOT_BOTTOM = 128;

const axisText = (
  h: H,
  x: number,
  y: number,
  anchor: "start" | "middle" | "end",
  label: string
) =>
  h.text(
    [
      h.Class("trend-label"),
      h.X(`${x}`),
      h.Y(`${y}`),
      h.Attribute("text-anchor", anchor),
    ],
    [label]
  );

const trendChart = (h: H, weeks: readonly TrendWeekValue[]): Html => {
  const peak = Math.max(1, ...weeks.map((week) => week.open));
  const slot = (PLOT_RIGHT - PLOT_LEFT) / Math.max(1, weeks.length);
  const height = PLOT_BOTTOM - PLOT_TOP;
  const summary = trendText(weeks);

  return h.figure(
    [h.Class("trend")],
    [
      h.svg(
        [
          h.Class("trend-chart"),
          h.ViewBox(`0 0 ${WIDTH} 160`),
          h.AriaHidden(true),
        ],
        [
          ...weeks.map((week, index) =>
            h.rect(
              [
                h.Class("trend-bar"),
                h.X(`${PLOT_LEFT + index * slot + slot * 0.15}`),
                h.Y(`${PLOT_BOTTOM - (week.open / peak) * height}`),
                h.Width(`${slot * 0.7}`),
                h.Height(`${(week.open / peak) * height}`),
              ],
              []
            )
          ),
          h.line(
            [
              h.Class("trend-axis"),
              h.Attribute("x1", `${PLOT_LEFT}`),
              h.Attribute("x2", `${PLOT_RIGHT}`),
              h.Attribute("y1", `${PLOT_BOTTOM}`),
              h.Attribute("y2", `${PLOT_BOTTOM}`),
            ],
            []
          ),
          h.line(
            [
              h.Class("trend-axis"),
              h.Attribute("x1", `${PLOT_LEFT}`),
              h.Attribute("x2", `${PLOT_LEFT}`),
              h.Attribute("y1", `${PLOT_TOP}`),
              h.Attribute("y2", `${PLOT_BOTTOM}`),
            ],
            []
          ),
          axisText(h, PLOT_LEFT - 6, PLOT_TOP + 4, "end", `${peak}`),
          axisText(h, PLOT_LEFT - 6, PLOT_BOTTOM, "end", "0"),
          axisText(h, PLOT_LEFT, 10, "start", "Open roles"),
          ...Array.match(weeks, {
            onEmpty: () => [],
            onNonEmpty: (all) => [
              axisText(
                h,
                PLOT_LEFT,
                144,
                "start",
                shortDate.format(Array.headNonEmpty(all).weekEnding)
              ),
              axisText(h, PLOT_RIGHT, 144, "end", "This week"),
            ],
          }),
          axisText(
            h,
            (PLOT_LEFT + PLOT_RIGHT) / 2,
            158,
            "middle",
            "Week ending"
          ),
        ]
      ),
      h.figcaption([h.Class("trend-summary")], [summary]),
    ]
  );
};

const trendView = (h: H, intel: CompanyIntelValue): Html =>
  Match.valueTags(intel.trend, {
    Shown: ({ weeks }) =>
      h.section(
        [h.Class("intel-block")],
        [h.h3([], ["13-week hiring trend"]), trendChart(h, weeks)]
      ),
    Thin: ({ roles, weeks }) =>
      h.section(
        [h.Class("intel-block")],
        [
          h.h3([], ["13-week hiring trend"]),
          h.p(
            [h.Class("trend-thin")],
            [
              `Not enough history for a trend yet. A trend needs at least 3 roles over 4 weeks, and this company has ${roles === 1 ? "1 role" : `${roles} roles`} over ${weeks === 1 ? "1 week" : `${weeks} weeks`}.`,
            ]
          ),
        ]
      ),
  });

const roleItem = (h: H, role: IntelRoleValue): Html =>
  h.li(
    [h.Class("intel-role")],
    [
      h.a([h.Href(jobRouter({ id: role.id }))], [role.title]),
      h.span(
        [h.Class("intel-role-facts")],
        [`Open ${days(role.daysOpen)}, ${times(role.reposts)}`]
      ),
    ]
  );

const rolesView = (h: H, roles: readonly IntelRoleValue[]): Html =>
  h.section(
    [h.Class("intel-block")],
    [
      h.h3([], ["How long each role has been open"]),
      Array.isReadonlyArrayEmpty(roles)
        ? h.p([], ["No open roles from company job boards right now."])
        : h.ul(
            [h.Class("intel-roles")],
            roles.map((role) => roleItem(h, role))
          ),
    ]
  );

const bandItem = (h: H, band: TypicalBandValue): Html =>
  h.li(
    [],
    [
      `${bandLabel(band)}, from ${band.roles === 1 ? "1 stated band" : `${band.roles} stated bands`}`,
    ]
  );

const bandsView = (h: H, bands: readonly TypicalBandValue[]): Html =>
  h.section(
    [h.Class("intel-block")],
    [
      h.h3([], ["Typical salary bands"]),
      Array.isReadonlyArrayEmpty(bands)
        ? h.p([], ["No stated salary bands from company job boards yet."])
        : h.ul(
            [h.Class("intel-bands")],
            bands.map((band) => bandItem(h, band))
          ),
    ]
  );

const sourceNote = (h: H, intel: CompanyIntelValue): Html =>
  h.p(
    [h.Class("source-note")],
    [
      intel.trackedSince === null
        ? "Built from company job boards. "
        : `Built from company job boards, with history since ${longDate.format(intel.trackedSince)}. `,
      `${excludedSources} roles are left out under their terms.`,
    ]
  );

const detailView = (h: H, intel: CompanyIntelValue): readonly Html[] => [
  trendView(h, intel),
  rolesView(h, intel.roles),
  bandsView(h, intel.bands),
  sourceNote(h, intel),
];

const teaser = (h: H): Html =>
  h.p(
    [h.Class("upgrade-prompt intel-teaser")],
    [
      `Pro shows how long each role has been open, how often it was reposted, a ${TREND_WEEKS}-week hiring trend, and typical salary bands. `,
      h.a([h.Href(pricingRouter())], ["See Pro plans"]),
    ]
  );

const proView = (
  h: HtmlBuilder<MessageValue>,
  model: ModelValue
): readonly Html[] =>
  IntelState.match<readonly Html[]>(model.intel, {
    Failed: () => [
      h.p([h.Role("alert")], ["Company intel could not load."]),
      h.button(
        [
          h.Type("button"),
          h.Class("more"),
          h.OnClick(Message.ClickedRetryIntel()),
        ],
        ["Try again"]
      ),
    ],
    Loaded: ({ intel }) => detailView(h, intel),
    Loading: () => [h.p([h.Role("status")], ["Loading company intel"])],
    Locked: () => [teaser(h)],
    NotAsked: () => [],
  });

const intelFor = (h: H, model: ModelValue): readonly Html[] => {
  if (isProMember(model.billing)) {
    return proView(h, model);
  }

  return isFreeViewer(model.account.session, model.billing) ? [teaser(h)] : [];
};

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
      ...intelFor(h, model),
    ]
  );
