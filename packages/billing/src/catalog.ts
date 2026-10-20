import { INSTANT_SENDS_PER_MEMBER_PER_DAY, PLAN_PRICES } from "@rat-stack/core";
import type { PlanValue } from "@rat-stack/core";
import * as Stripe from "alchemy/Stripe";
import * as Effect from "effect/Effect";

import { BILLING_EVENTS, STRIPE_WEBHOOK_PATH } from "./webhook.js";

export const PRO_PRODUCT_NAME = "Pro";

export const PRO_PRODUCT_DESCRIPTION = `Email alerts within 20 minutes of a new match for your saved searches, up to ${INSTANT_SENDS_PER_MEMBER_PER_DAY} a day, salary-floor and seniority filters, and a filter for roles that state a salary.`;

const proPrice = (product: Stripe.Product, plan: PlanValue) =>
  Stripe.Price(`Pro${plan}Price`, {
    currency: "usd",
    metadata: { plan },
    nickname: `Pro ${plan}`,
    product,
    recurring: {
      interval: PLAN_PRICES[plan].interval,
      intervalCount: PLAN_PRICES[plan].intervalCount,
    },
    unitAmount: PLAN_PRICES[plan].amountCents,
  });

export const ProCatalog = (siteOrigin: string) =>
  Effect.gen(function* proCatalog() {
    const product = yield* Stripe.Product("ProProduct", {
      description: PRO_PRODUCT_DESCRIPTION,
      name: PRO_PRODUCT_NAME,
    });

    const prices = {
      Monthly: yield* proPrice(product, "Monthly"),
      Quarterly: yield* proPrice(product, "Quarterly"),
      Yearly: yield* proPrice(product, "Yearly"),
    };

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
