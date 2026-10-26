import {
  digestSourceLabels,
  INSTANT_SENDS_PER_MEMBER_PER_DAY,
  isPro,
  ProEntitlement,
  SOURCE_REPOSITORY_URL,
} from "@rat-stack/core/contracts";
import type {
  BillingIntervalValue,
  EntitlementValue,
  MembershipValue,
  PlanOfferValue,
  PlanValue,
} from "@rat-stack/core/contracts";
import { Array, Option, Schema } from "effect";
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

const proFeatures = [
  `Instant alerts within 20 minutes of a new match, up to ${INSTANT_SENDS_PER_MEMBER_PER_DAY} emails a day`,
  "Show only roles that state a salary",
  "Salary floor and seniority filters",
  "Company intel",
];

const RUN_YOUR_OWN_URL = `${SOURCE_REPOSITORY_URL}#run-your-own`;

const featureList = <M>(h: HtmlBuilder<M>, items: readonly string[]) =>
  h.ul(
    [h.Class("plan-features")],
    items.map((item) => h.li([], [item]))
  );

const headlineOffer = (model: ModelValue) => Array.head(plansOnSale(model));

const proPrice = <M>(model: ModelValue, h: HtmlBuilder<M>): Html =>
  Option.match(headlineOffer(model), {
    onNone: () =>
      Schema.is(PlansState.Loaded)(model.plans)
        ? h.p([h.Class("price-card-price price-card-soon")], ["Coming soon"])
        : h.empty,
    onSome: (offer) =>
      h.p(
        [h.Class("price-card-price")],
        [
          dollars(offer.amountCents),
          h.span([h.Class("price-card-cadence")], [` / ${cadenceOf(offer)}`]),
        ]
      ),
  });

const priceCard = <M>(
  h: HtmlBuilder<M>,
  id: string,
  isProCard: boolean,
  content: readonly Html[]
): Html =>
  h.section(
    [
      h.Class(isProCard ? "price-card price-card-pro" : "price-card"),
      h.AriaLabelledBy(id),
    ],
    content
  );

const cardName = <M>(h: HtmlBuilder<M>, id: string, name: string) =>
  h.h2([h.Id(id), h.Class("price-card-name")], [name]);

const cardPrice = <M>(h: HtmlBuilder<M>, price: string) =>
  h.p([h.Class("price-card-price")], [price]);

const selfHostCard = <M>(h: HtmlBuilder<M>, idPrefix: string): Html =>
  priceCard(h, `${idPrefix}-self-host`, false, [
    cardName(h, `${idPrefix}-self-host`, "Self-host"),
    cardPrice(h, "MIT"),
    h.p(
      [h.Class("price-card-copy")],
      [
        "Open source. Run the whole board, the crawler and the agent tools on your own Cloudflare account.",
      ]
    ),
    h.a(
      [h.Class("price-card-button"), h.Href(RUN_YOUR_OWN_URL)],
      ["Run your own"]
    ),
  ]);

export const pricingSummary = <M>(model: ModelValue, h: HtmlBuilder<M>) =>
  h.section(
    [h.Id("pricing"), h.Class("price-cards"), h.AriaLabel("Pricing")],
    [
      priceCard(h, "summary-free", false, [
        cardName(h, "summary-free", "Free"),
        cardPrice(h, "$0"),
        h.p(
          [h.Class("price-card-copy")],
          [
            "Every listing, search and filters by role, place and age, your application tracker and weekly email digests.",
          ]
        ),
      ]),
      priceCard(h, "summary-pro", true, [
        cardName(h, "summary-pro", "Pro"),
        proPrice(model, h),
        h.p(
          [h.Class("price-card-copy")],
          [
            "Instant alerts for new matches, salary and seniority filters, and company intel.",
          ]
        ),
        ...(sellsPro(model) && !isProMember(model)
          ? [
              h.a(
                [h.Class("price-card-button"), h.Href(pricingHref)],
                ["Get Pro"]
              ),
            ]
          : []),
      ]),
      selfHostCard(h, "summary"),
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
      ...(isOnlyPlan
        ? []
        : [
            h.h3([h.Class("plan-name")], [offer.plan]),
            h.p(
              [h.Class("plan-price")],
              [
                h.strong([], [dollars(offer.amountCents)]),
                ` / ${cadenceOf(offer)}`,
              ]
            ),
          ]),
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

  return offers.length === 0
    ? []
    : [
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
      h.div(
        [h.Class("price-cards")],
        [
          priceCard(h, "tier-free", false, [
            cardName(h, "tier-free", "Free"),
            cardPrice(h, "$0"),
            featureList(h, freeFeatures),
          ]),
          priceCard(h, "tier-pro", true, [
            cardName(h, "tier-pro", "Pro"),
            proPrice(model, h),
            h.p([h.Class("price-card-copy")], ["Everything in Free, plus:"]),
            featureList(h, proFeatures),
            h.p([h.Class("price-card-copy")], [instantCoverage()]),
            ...planOffers(model, session, h),
          ]),
          selfHostCard(h, "tier"),
        ]
      ),
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
  isCurrent: boolean,
  h: HtmlBuilder<M>
): Html => {
  if (isProMember(model)) {
    return h.span(
      [h.Class("pro-badge"), h.AriaLabel("Your plan: Pro")],
      ["Pro"]
    );
  }

  return h.a(
    [
      h.Class("nav-link"),
      h.Href(pricingHref),
      ...(isCurrent ? [h.AriaCurrent("page")] : []),
    ],
    ["Pricing"]
  );
};
