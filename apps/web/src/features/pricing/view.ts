import {
  digestSourceLabels,
  INSTANT_SENDS_PER_MEMBER_PER_DAY,
  isPro,
  PLAN_PRICES,
  plans,
  ProEntitlement,
} from "@rat-stack/core/contracts";
import type {
  EntitlementValue,
  MembershipValue,
  PlanValue,
} from "@rat-stack/core/contracts";
import { Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineView } from "foldkit/submodel";

import { SessionState } from "../../client/account/model.js";
import type { SessionStateValue } from "../../client/account/model.js";
import { Message } from "../../client/billing/message.js";
import type { MessageValue } from "../../client/billing/message.js";
import {
  BillingAction,
  isProMember,
  MembershipState,
} from "../../client/billing/model.js";
import type { ModelValue } from "../../client/billing/model.js";
import { accountRouter, pricingRouter } from "../../client/route.js";
import type { AccountNoticeValue } from "../../client/route.js";

const pricingHref = pricingRouter();

const accountHref = accountRouter({ notice: "None" });

const longDate = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeZone: "UTC",
});

export const calendarDate = (at: number) => longDate.format(at);

const dollars = (cents: number) => `$${cents / 100}`;

const planCopy: Record<
  PlanValue,
  { readonly name: string; readonly per: string }
> = {
  Monthly: { name: "Monthly", per: "a month" },
  Quarterly: { name: "Quarterly", per: "every 3 months" },
  Yearly: { name: "Yearly", per: "a year" },
};

const monthsOf = (plan: PlanValue) =>
  PLAN_PRICES[plan].interval === "year"
    ? 12 * PLAN_PRICES[plan].intervalCount
    : PLAN_PRICES[plan].intervalCount;

export const savingOf = (plan: PlanValue) => {
  const monthly = PLAN_PRICES.Monthly.amountCents * monthsOf(plan);

  return Math.round((1 - PLAN_PRICES[plan].amountCents / monthly) * 100);
};

export const instantCoverage = (
  labels: readonly string[] = digestSourceLabels()
) =>
  labels.length === 0
    ? "Instant alerts cover no job sources yet."
    : `Like the weekly digest, instant alerts only list roles from ${labels.join(" and ")}.`;

const freeFeatures = [
  "Every listing, with links to apply at the source",
  "Search and filters by role, place and age",
  "Your application tracker",
  "Weekly email digests for saved searches",
];

const proFeatures: readonly (readonly [string, boolean])[] = [
  [
    `Instant alerts within 20 minutes of a new match, up to ${INSTANT_SENDS_PER_MEMBER_PER_DAY} emails a day`,
    true,
  ],
  ["Show only roles that state a salary", true],
  ["Salary floor and seniority filters", false],
  ["Company intel", false],
];

const featureList = (h: HtmlBuilder<MessageValue>, items: readonly Html[]) =>
  h.ul([h.Class("plan-features")], items);

const tiers = (h: HtmlBuilder<MessageValue>): Html =>
  h.div(
    [h.Class("tiers")],
    [
      h.section(
        [h.Class("tier"), h.AriaLabelledBy("tier-free")],
        [
          h.h2([h.Id("tier-free")], ["Free"]),
          featureList(
            h,
            freeFeatures.map((feature) => h.li([], [feature]))
          ),
        ]
      ),
      h.section(
        [h.Class("tier tier-pro"), h.AriaLabelledBy("tier-pro")],
        [
          h.h2([h.Id("tier-pro")], ["Pro"]),
          h.p([h.Class("tier-lede")], ["Everything in Free, plus:"]),
          featureList(
            h,
            proFeatures.map(([feature, isLive]) =>
              h.li(
                [],
                isLive
                  ? [feature]
                  : [feature, " ", h.span([h.Class("soon")], ["coming soon"])]
              )
            )
          ),
          h.p([h.Class("tier-note")], [instantCoverage()]),
        ]
      ),
    ]
  );

const planAction = (
  model: ModelValue,
  session: SessionStateValue,
  plan: PlanValue,
  h: HtmlBuilder<MessageValue>
): Html => {
  if (!Schema.is(SessionState.SignedIn)(session)) {
    return h.a(
      [h.Class("plan-button"), h.Href(accountHref)],
      ["Sign in to upgrade"]
    );
  }

  if (isProMember(model)) {
    return h.span([h.Class("plan-note")], ["You have Pro"]);
  }

  const isBusy =
    Schema.is(BillingAction.Redirecting)(model.action) ||
    Schema.is(MembershipState.Loading)(model.membership);

  return h.button(
    [
      h.Type("button"),
      h.Class("plan-button"),
      h.Disabled(isBusy),
      h.AriaLabel(`Choose Pro ${planCopy[plan].name}`),
      h.OnClick(Message.ClickedChoosePlan({ plan })),
    ],
    [`Choose ${planCopy[plan].name.toLowerCase()}`]
  );
};

const planCard = (
  model: ModelValue,
  session: SessionStateValue,
  plan: PlanValue,
  h: HtmlBuilder<MessageValue>
): Html => {
  const saving = savingOf(plan);

  return h.keyed("li")(
    plan,
    [h.Class(plan === "Yearly" ? "plan plan-best" : "plan")],
    [
      h.h3([h.Class("plan-name")], [planCopy[plan].name]),
      h.p(
        [h.Class("plan-price")],
        [
          h.strong([], [dollars(PLAN_PRICES[plan].amountCents)]),
          ` ${planCopy[plan].per}`,
        ]
      ),
      h.p(
        [h.Class("plan-saving")],
        [saving > 0 ? `Save ${saving}% against monthly` : "Cancel any time"]
      ),
      planAction(model, session, plan, h),
    ]
  );
};

const actionNote = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): readonly Html[] =>
  BillingAction.match<readonly Html[]>(model.action, {
    Idle: () => [],
    Problem: ({ message }) => [
      h.p([h.Class("billing-problem"), h.Role("alert")], [message]),
    ],
    Redirecting: () => [
      h.p([h.Class("status"), h.Role("status")], ["Opening Stripe…"]),
    ],
    Saving: () => [],
  });

export const pricingPage = defineView<
  ModelValue,
  MessageValue,
  { readonly session: SessionStateValue }
>((model, { session }, h) =>
  h.div(
    [h.Class("detail pricing")],
    [
      h.h1([h.Class("detail-title")], ["Pro for engineering leaders"]),
      h.p(
        [h.Class("account-lede")],
        [
          "The board stays free for everyone. Pro adds faster alerts and sharper filters for people actively looking.",
        ]
      ),
      tiers(h),
      h.ul(
        [h.Class("plans"), h.AriaLabel("Pro plans")],
        plans.map((plan) => planCard(model, session, plan, h))
      ),
      ...actionNote(model, h),
      h.p(
        [h.Class("tier-note")],
        [
          "Stripe handles payment. Cancel any time from the billing portal, and Pro stays on until the end of the period you paid for. Prices in US dollars.",
        ]
      ),
    ]
  )
);

const statusOf = (entitlement: EntitlementValue): string =>
  Schema.is(ProEntitlement)(entitlement)
    ? `You have Pro ${planCopy[entitlement.plan].name.toLowerCase()}. It ${entitlement.renews ? "renews" : "ends"} on ${calendarDate(entitlement.periodEnd)}.`
    : "You are on Free.";

const instantToggle = (
  model: ModelValue,
  membership: MembershipValue,
  h: HtmlBuilder<MessageValue>
): Html =>
  h.p(
    [h.Class("instant-toggle")],
    [
      h.button(
        [
          h.Type("button"),
          h.Class(membership.instantAlerts ? "phrase phrase-on" : "phrase"),
          h.AriaPressed(membership.instantAlerts ? "true" : "false"),
          h.Disabled(Schema.is(BillingAction.Saving)(model.action)),
          h.OnClick(
            Message.ToggledInstantAlerts({ enabled: !membership.instantAlerts })
          ),
        ],
        [membership.instantAlerts ? "Instant alerts on" : "Instant alerts off"]
      ),
      ` Email me within 20 minutes of a new match for my saved searches, up to ${INSTANT_SENDS_PER_MEMBER_PER_DAY} times a day.`,
    ]
  );

const checkoutNote = (
  model: ModelValue,
  membership: MembershipValue,
  notice: AccountNoticeValue,
  h: HtmlBuilder<MessageValue>
): readonly Html[] => {
  if (notice !== "CheckoutDone" || isPro(membership.entitlement)) {
    return [];
  }

  return [
    h.p(
      [h.Class("status"), h.Role("status")],
      [
        model.pollsLeft > 0
          ? "Thanks for upgrading. Waiting for Stripe to confirm the payment…"
          : "Stripe has not confirmed the payment yet. Reload this page in a minute. You were not charged twice.",
      ]
    ),
  ];
};

const loadedPanel = (
  model: ModelValue,
  membership: MembershipValue,
  notice: AccountNoticeValue,
  h: HtmlBuilder<MessageValue>
): readonly Html[] => [
  ...checkoutNote(model, membership, notice, h),
  h.p(
    [h.Class("account-lede plan-status")],
    [statusOf(membership.entitlement)]
  ),
  ...(isPro(membership.entitlement)
    ? [
        instantToggle(model, membership, h),
        h.p([h.Class("tier-note")], [instantCoverage()]),
        h.button(
          [
            h.Type("button"),
            h.Class("more"),
            h.Disabled(Schema.is(BillingAction.Redirecting)(model.action)),
            h.OnClick(Message.ClickedManageBilling()),
          ],
          ["Manage billing"]
        ),
      ]
    : [
        h.p(
          [h.Class("account-lede")],
          [
            "Pro adds instant alerts and salary filters. ",
            h.a([h.Href(pricingHref)], ["See Pro plans"]),
          ]
        ),
      ]),
  ...actionNote(model, h),
];

export const billingPanel = defineView<
  ModelValue,
  MessageValue,
  { readonly notice: AccountNoticeValue }
>((model, { notice }, h) =>
  h.section(
    [h.Class("billing"), h.AriaLabelledBy("billing-title")],
    [
      h.h2([h.Id("billing-title")], ["Plan"]),
      ...MembershipState.match<readonly Html[]>(model.membership, {
        Failed: () => [
          h.p(
            [h.Class("status"), h.Role("alert")],
            ["We could not load your plan. Reload to try again."]
          ),
        ],
        Loaded: ({ membership }) => loadedPanel(model, membership, notice, h),
        Loading: () => [
          h.p([h.Class("status"), h.Role("status")], ["Loading your plan…"]),
        ],
        Unknown: () => [],
      }),
    ]
  )
);

export const planLink = <M>(
  model: ModelValue,
  session: SessionStateValue,
  isCurrent: boolean,
  h: HtmlBuilder<M>
): Html =>
  isProMember(model)
    ? h.span([h.Class("pro-badge"), h.AriaLabel("Your plan: Pro")], ["Pro"])
    : h.a(
        [
          h.Class(isCurrent ? "tab tab-on" : "tab"),
          h.Href(pricingHref),
          ...(isCurrent ? [h.AriaCurrent("page")] : []),
        ],
        [Schema.is(SessionState.SignedIn)(session) ? "Upgrade" : "Pricing"]
      );
