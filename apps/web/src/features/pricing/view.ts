import {
  digestSourceLabels,
  INSTANT_SENDS_PER_MEMBER_PER_DAY,
  isPro,
  ProEntitlement,
} from "@rat-stack/core/contracts";
import type {
  BillingIntervalValue,
  EntitlementValue,
  MembershipValue,
  PlanOfferValue,
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
  plansOnSale,
  PlansState,
  sellsPro,
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

const dollars = (cents: number) =>
  `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;

const cadenceOf = ({ interval, intervalCount }: PlanOfferValue) =>
  intervalCount === 1 ? interval : `${intervalCount} ${interval}s`;

const DAYS: Record<BillingIntervalValue, number> = {
  day: 1,
  month: 30.4375,
  week: 7,
  year: 365.25,
};

const perDay = (offer: PlanOfferValue) =>
  offer.amountCents / (DAYS[offer.interval] * offer.intervalCount);

export const savingOf = (
  offer: PlanOfferValue,
  offers: readonly PlanOfferValue[]
) => {
  const highest = Math.max(...offers.map(perDay));
  const dearest = offers.find((other) => perDay(other) === highest) ?? offer;

  return {
    against: dearest.plan,
    percent: Math.round((1 - perDay(offer) / perDay(dearest)) * 100),
  };
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
  ["Salary floor and seniority filters", true],
  ["Company intel", true],
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
  isOnlyPlan: boolean,
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
      h.OnClick(Message.ClickedChoosePlan({ plan })),
    ],
    [isOnlyPlan ? "Upgrade to Pro" : `Choose ${plan}`]
  );
};

const planCard = (
  model: ModelValue,
  session: SessionStateValue,
  offer: PlanOfferValue,
  offers: readonly PlanOfferValue[],
  h: HtmlBuilder<MessageValue>
): Html => {
  const saving = savingOf(offer, offers);
  const best = offers.every((other) => perDay(offer) <= perDay(other));
  const isOnlyPlan = offers.length === 1;

  return h.keyed("li")(
    offer.plan,
    [h.Class(best && !isOnlyPlan ? "plan plan-best" : "plan")],
    [
      ...(isOnlyPlan ? [] : [h.h3([h.Class("plan-name")], [offer.plan])]),
      h.p(
        [h.Class("plan-price")],
        [h.strong([], [dollars(offer.amountCents)]), ` / ${cadenceOf(offer)}`]
      ),
      h.p(
        [h.Class("plan-saving")],
        [
          saving.percent > 0
            ? `Save ${saving.percent}% against ${saving.against}`
            : "Cancel any time",
        ]
      ),
      planAction(model, session, offer.plan, isOnlyPlan, h),
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

const planOffers = (
  model: ModelValue,
  session: SessionStateValue,
  h: HtmlBuilder<MessageValue>
): readonly Html[] => {
  const offers = plansOnSale(model);

  if (offers.length > 0) {
    return [
      h.ul(
        [h.Class("plans"), h.AriaLabel("Pro plans")],
        offers.map((offer) => planCard(model, session, offer, offers, h))
      ),
      ...actionNote(model, h),
      h.p(
        [h.Class("tier-note")],
        [
          "Stripe handles payment. Cancel any time from the billing portal, and Pro stays on until the end of the period you paid for. Prices in US dollars.",
        ]
      ),
    ];
  }

  return Schema.is(PlansState.Loaded)(model.plans)
    ? [h.p([h.Class("tier-note")], ["Pro is not on sale on this site."])]
    : [];
};

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
      ...planOffers(model, session, h),
    ]
  )
);

const statusOf = (entitlement: EntitlementValue): string =>
  Schema.is(ProEntitlement)(entitlement)
    ? `You have Pro ${entitlement.plan}. It ${entitlement.renews ? "renews" : "ends"} on ${calendarDate(entitlement.periodEnd)}.`
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

const proUpsell = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): readonly Html[] =>
  sellsPro(model)
    ? [
        h.p(
          [h.Class("account-lede")],
          [
            "Pro adds instant alerts and salary filters. ",
            h.a([h.Href(pricingHref)], ["See Pro plans"]),
          ]
        ),
      ]
    : [];

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
    : proUpsell(model, h)),
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
): Html => {
  if (isProMember(model)) {
    return h.span(
      [h.Class("pro-badge"), h.AriaLabel("Your plan: Pro")],
      ["Pro"]
    );
  }

  return sellsPro(model)
    ? h.a(
        [
          h.Class(isCurrent ? "tab tab-on" : "tab"),
          h.Href(pricingHref),
          ...(isCurrent ? [h.AriaCurrent("page")] : []),
        ],
        [Schema.is(SessionState.SignedIn)(session) ? "Upgrade" : "Pricing"]
      )
    : h.empty;
};
