import { INSTANT_SENDS_PER_MEMBER_PER_DAY, PlanOffer } from "@rat-stack/core";
import type { PlanOfferValue } from "@rat-stack/core";
import * as Stripe from "alchemy/Stripe";
import { Effect, Schema } from "effect";

import { BILLING_EVENTS, STRIPE_WEBHOOK_PATH } from "./webhook.js";

export const PRO_PRODUCT_NAME = "Pro";

export const PRO_PRODUCT_DESCRIPTION = `Email alerts within 20 minutes of a new match for your saved searches, up to ${INSTANT_SENDS_PER_MEMBER_PER_DAY} a day, salary-floor and seniority filters, a filter for roles that state a salary, and company intel with hiring trends, salary bands and repost history.`;

export const ProPlanSetting = Schema.Struct({
  ...PlanOffer.fields,
  intervalCount: PlanOffer.fields.intervalCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(1))
  ),
  onSale: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});

export type ProPlanSettingValue = typeof ProPlanSetting.Type;

const ProPlanSettings = Schema.Array(ProPlanSetting).check(
  Schema.makeFilter(
    (settings) =>
      new Set(settings.map(({ plan }) => plan)).size === settings.length ||
      "each plan must appear once"
  )
);

export const ProPlansSetting = Schema.Union([
  Schema.Literal(""),
  Schema.fromJsonString(ProPlanSettings),
]);

export const proPlansOf = (
  setting: typeof ProPlansSetting.Type
): readonly ProPlanSettingValue[] => (setting === "" ? [] : setting);

const offerOf = ({
  amountCents,
  interval,
  intervalCount,
  plan,
}: ProPlanSettingValue): PlanOfferValue => ({
  amountCents,
  interval,
  intervalCount,
  plan,
});

export const priceBook = <Id>(
  prices: readonly {
    readonly priceId: Id;
    readonly setting: ProPlanSettingValue;
  }[]
) => ({
  entitled: prices.map(
    ({ priceId, setting }) => [priceId, setting.plan] as const
  ),
  onSale: prices.flatMap(({ priceId, setting }) =>
    setting.onSale ? [{ offer: offerOf(setting), priceId }] : []
  ),
});

const proPrice = (product: Stripe.Product, setting: ProPlanSettingValue) =>
  Stripe.Price(`Pro${setting.plan}Price`, {
    active: setting.onSale,
    currency: "usd",
    metadata: { plan: setting.plan },
    nickname: `Pro ${setting.plan}`,
    product,
    recurring: {
      interval: setting.interval,
      intervalCount: setting.intervalCount,
    },
    unitAmount: setting.amountCents,
  });

export const ProCatalog = (
  siteOrigin: string,
  settings: readonly ProPlanSettingValue[]
) =>
  Effect.gen(function* proCatalog() {
    const product = yield* Stripe.Product("ProProduct", {
      description: PRO_PRODUCT_DESCRIPTION,
      name: PRO_PRODUCT_NAME,
    });

    const prices = yield* Effect.all(
      settings.map((setting) =>
        proPrice(product, setting).pipe(
          Effect.map((price) => ({ price, setting }))
        )
      )
    );

    const portal = yield* Stripe.BillingPortalConfiguration("ProPortal", {
      defaultReturnUrl: new URL("/account", siteOrigin).href,
      features: {
        invoiceHistory: { enabled: true },
        paymentMethodUpdate: { enabled: true },
        subscriptionCancel: { enabled: true, mode: "at_period_end" },
      },
    });

    const webhook = yield* Stripe.WebhookEndpoint("ProWebhook", {
      description: "Pro entitlements",
      enabledEvents: [...BILLING_EVENTS],
      url: new URL(STRIPE_WEBHOOK_PATH, siteOrigin).href,
    });

    return { portal, prices, webhook };
  });
