import { describe, expect, it } from "@effect/vitest";
import { Account } from "@rat-stack/core";
import { Effect, Option, Schema } from "effect";

import {
  billingOff,
  makeBilling,
  priceBook,
  PRO_PRODUCT_DESCRIPTION,
  proPlansOf,
  ProPlansSetting,
} from "../src/index.js";
import type {
  CheckoutSessionRequest,
  ProPlanSettingValue,
} from "../src/index.js";

describe("Pro product shown on Checkout", () => {
  it("names the shipped Pro alerts, filters and company intel", () => {
    expect([
      /seniority/iu.test(PRO_PRODUCT_DESCRIPTION),
      /intel/iu.test(PRO_PRODUCT_DESCRIPTION),
      /floor/iu.test(PRO_PRODUCT_DESCRIPTION),
      PRO_PRODUCT_DESCRIPTION.includes("up to 6 a day"),
      PRO_PRODUCT_DESCRIPTION.includes("roles that state a salary"),
    ]).toEqual([true, true, true, true, true]);
  });
});

const decodePlans = (text: string) =>
  Schema.decodeUnknownOption(ProPlansSetting)(text).pipe(
    Option.map(proPlansOf)
  );

describe("PRO_PLANS setting", () => {
  it("reads a weekly plan and fills the interval count and sale defaults", () => {
    expect(
      decodePlans('[{"plan":"Weekly","amountCents":500,"interval":"week"}]')
    ).toEqual(
      Option.some([
        {
          amountCents: 500,
          interval: "week",
          intervalCount: 1,
          onSale: true,
          plan: "Weekly",
        },
      ])
    );
  });

  it("reads an empty setting as no plans", () => {
    expect(decodePlans("")).toEqual(Option.some([]));
  });

  it("refuses a repeated plan, an unknown interval and a lowercase name", () => {
    expect([
      decodePlans(
        '[{"plan":"Weekly","amountCents":500,"interval":"week"},{"plan":"Weekly","amountCents":600,"interval":"week"}]'
      ),
      decodePlans(
        '[{"plan":"Weekly","amountCents":500,"interval":"fortnight"}]'
      ),
      decodePlans('[{"plan":"weekly","amountCents":500,"interval":"week"}]'),
    ]).toEqual([Option.none(), Option.none(), Option.none()]);
  });

  it("reads a first-period price below the plan price", () => {
    expect(
      decodePlans(
        '[{"plan":"Weekly","amountCents":500,"interval":"week","onSale":false},{"plan":"Monthly","amountCents":799,"interval":"month","firstPeriodCents":499}]'
      ).pipe(Option.map((plans) => plans.map((plan) => plan.firstPeriodCents)))
    ).toEqual(Option.some([undefined, 499]));
  });

  it.each(["0", "-1", "799", "900", "4.5", '"499"'])(
    "refuses a first-period price of %s against a 799 cent plan",
    (cents) => {
      expect(
        decodePlans(
          `[{"plan":"Monthly","amountCents":799,"interval":"month","firstPeriodCents":${cents}}]`
        )
      ).toEqual(Option.none());
    }
  );

  it("refuses a misspelt key instead of keeping the plan on sale", () => {
    expect(
      decodePlans(
        '[{"plan":"Monthly","amountCents":1900,"interval":"month","onsale":false}]'
      )
    ).toEqual(Option.none());
  });
});

const weekly: ProPlanSettingValue = {
  amountCents: 500,
  interval: "week",
  intervalCount: 1,
  onSale: true,
  plan: "Weekly",
};

const retiredMonthly: ProPlanSettingValue = {
  amountCents: 1900,
  interval: "month",
  intervalCount: 1,
  onSale: false,
  plan: "Monthly",
};

describe("priceBook", () => {
  it("keeps Pro for a retired monthly price while only the weekly plan is on sale", () => {
    const book = priceBook([
      { couponId: Option.none(), priceId: "price_weekly", setting: weekly },
      {
        couponId: Option.none(),
        priceId: "price_monthly",
        setting: retiredMonthly,
      },
    ]);

    expect(book.entitled).toEqual([
      ["price_weekly", "Weekly"],
      ["price_monthly", "Monthly"],
    ]);
    expect(book.onSale).toEqual([
      {
        couponId: Option.none(),
        offer: {
          amountCents: 500,
          interval: "week",
          intervalCount: 1,
          plan: "Weekly",
        },
        priceId: "price_weekly",
      },
    ]);
  });
});

const ada = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

const introMonthly: ProPlanSettingValue = {
  amountCents: 799,
  firstPeriodCents: 499,
  interval: "month",
  intervalCount: 1,
  onSale: true,
  plan: "Monthly",
};

const billingSelling = (
  checkouts: CheckoutSessionRequest[],
  plans: readonly {
    readonly couponId: Option.Option<string>;
    readonly priceId: string;
    readonly setting: ProPlanSettingValue;
  }[] = [
    { couponId: Option.none(), priceId: "price_weekly", setting: weekly },
    {
      couponId: Option.none(),
      priceId: "price_monthly",
      setting: retiredMonthly,
    },
  ]
) =>
  makeBilling({
    createCheckout: (request) =>
      Effect.sync(() => {
        checkouts.push(request);

        return { url: "https://pay.example" };
      }),
    createCustomer: () => Effect.succeed({ id: "cus_ada" }),
    createPortal: () => Effect.succeed({ url: "https://portal.example" }),
    onSale: priceBook(
      plans.map(({ couponId, priceId, setting }) => ({
        couponId: couponId.pipe(Option.map((id) => Effect.succeed(id))),
        priceId: Effect.succeed(priceId),
        setting,
      }))
    ).onSale,
    portalConfiguration: Effect.succeed("bpc_1"),
    siteOrigin: "https://jobs.example",
  });

const pricesOf = (checkouts: readonly CheckoutSessionRequest[]) =>
  checkouts.map((request) => request.line_items[0]?.price);

describe("checkout with configured plans", () => {
  it.effect("checks out the weekly price and lists only the weekly offer", () =>
    Effect.gen(function* weeklyCheckout() {
      const checkouts: CheckoutSessionRequest[] = [];
      const billing = billingSelling(checkouts);

      yield* billing.checkout({
        account: ada,
        customer: "cus_ada",
        plan: "Weekly",
      });

      expect(pricesOf(checkouts)).toEqual(["price_weekly"]);
      expect(billing.plans.map(({ plan }) => plan)).toEqual(["Weekly"]);
    })
  );

  it.effect("refuses a retired plan without opening a Stripe checkout", () =>
    Effect.gen(function* retiredCheckout() {
      const checkouts: CheckoutSessionRequest[] = [];

      const failure = yield* billingSelling(checkouts)
        .checkout({ account: ada, customer: "cus_ada", plan: "Monthly" })
        .pipe(Effect.flip);

      expect(failure._tag).toBe("BillingUnavailable");
      expect(checkouts).toEqual([]);
    })
  );

  it.effect(
    "takes the first-period coupon off the intro plan's checkout only and lists its first-period price",
    () =>
      Effect.gen(function* introCheckout() {
        const checkouts: CheckoutSessionRequest[] = [];

        const billing = billingSelling(checkouts, [
          { couponId: Option.none(), priceId: "price_weekly", setting: weekly },
          {
            couponId: Option.some("coupon_monthly_first"),
            priceId: "price_monthly",
            setting: introMonthly,
          },
        ]);

        yield* billing.checkout({
          account: ada,
          customer: "cus_ada",
          plan: "Monthly",
        });
        yield* billing.checkout({
          account: ada,
          customer: "cus_ada",
          plan: "Weekly",
        });

        expect(
          checkouts.map((request) => [
            request.line_items[0]?.price,
            "discounts" in request ? request.discounts : "none",
          ])
        ).toEqual([
          ["price_monthly", [{ coupon: "coupon_monthly_first" }]],
          ["price_weekly", "none"],
        ]);
        expect(billing.plans.map((offer) => offer.firstPeriodCents)).toEqual([
          undefined,
          499,
        ]);
      })
  );

  it("sells nothing when billing is off", () => {
    expect(billingOff.plans).toEqual([]);
  });
});
