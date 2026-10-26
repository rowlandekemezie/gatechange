import { describe, expect, it } from "@effect/vitest";
import { Account, FREE, ProEntitlement } from "@rat-stack/core/contracts";
import type {
  MembershipValue,
  PlanOfferValue,
} from "@rat-stack/core/contracts";
import { Effect, Option, Schema } from "effect";
import { renderToString } from "foldkit/experimental/server";
import { fromString } from "foldkit/url";

import { Message as AccountMessage } from "../src/client/account/message.js";
import { SessionState } from "../src/client/account/model.js";
import { application } from "../src/client/application.js";
import { Message } from "../src/client/billing/message.js";
import {
  BillingAction,
  MembershipState,
  PlansState,
} from "../src/client/billing/model.js";
import type { ModelValue as BillingModelValue } from "../src/client/billing/model.js";
import { CHECKOUT_POLLS, init, update } from "../src/client/billing/update.js";
import { defaultFilters } from "../src/client/board/filters.js";
import { Message as BoardMessage } from "../src/client/board/message.js";
import { Preload } from "../src/client/board/model.js";
import {
  init as boardInit,
  update as boardUpdate,
} from "../src/client/board/update.js";
import { boardUrl, Route, routeOfUrl } from "../src/client/route.js";
import { edgeRouteOf } from "../src/edge-routes.js";
import { savingOf } from "../src/features/pricing/view.js";

const ORIGIN = "https://jobs.example";

const urlAt = (path: string) =>
  Option.getOrThrow(fromString(`${ORIGIN}${path}`));

const flags = { origin: ORIGIN, preload: Preload.Nothing() };

const ada = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

const free: MembershipValue = { entitlement: FREE, instantAlerts: false };

const pro: MembershipValue = {
  entitlement: ProEntitlement.make({
    periodEnd: Date.UTC(2026, 10, 18),
    plan: "Monthly",
    renews: true,
  }),
  instantAlerts: true,
};

const offers: readonly PlanOfferValue[] = [
  { amountCents: 500, interval: "week", intervalCount: 1, plan: "Weekly" },
  { amountCents: 1900, interval: "month", intervalCount: 1, plan: "Monthly" },
  { amountCents: 14_900, interval: "year", intervalCount: 1, plan: "Yearly" },
];

const commandNames = (step: {
  readonly commands?: readonly { readonly name: string }[];
}) => (step.commands ?? []).map((command) => command.name);

const loaded = (membership: MembershipValue): BillingModelValue => ({
  ...init().model,
  membership: MembershipState.Loaded({ membership }),
  plans: PlansState.Loaded({ plans: offers }),
});

const renderAs = (
  path: string,
  session: typeof SessionState.Type,
  membership: Option.Option<MembershipValue>,
  plans: readonly PlanOfferValue[] = offers
) =>
  renderToString(
    {
      ...application,
      init: (...args: Parameters<typeof application.init>) => {
        const started = application.init(...args);

        return {
          ...started,
          model: {
            ...started.model,
            account: { ...started.model.account, session },
            billing: {
              ...Option.match(membership, {
                onNone: () => started.model.billing,
                onSome: loaded,
              }),
              plans: PlansState.Loaded({ plans }),
            },
          },
        };
      },
    },
    { flags, url: `${ORIGIN}${path}` }
  ).pipe(Effect.map(({ html }) => html));

const textOf = (html: string) =>
  html.replaceAll(/<[^>]+>/gu, " ").replaceAll(/\s+/gu, " ");

describe("billing routes", () => {
  it("opens the pricing page, the post-checkout account page, and the salary filter from links", () => {
    const board = routeOfUrl(urlAt("/?salary=listed"));

    expect(Schema.is(Route.Pricing)(routeOfUrl(urlAt("/pricing")))).toBe(true);
    expect(routeOfUrl(urlAt("/account?checkout=done"))).toEqual(
      Route.Account({ notice: "CheckoutDone" })
    );
    expect(Schema.is(Route.Board)(board) && board.filters.salaryListed).toBe(
      true
    );
    expect(boardUrl({ ...defaultFilters, salaryListed: true })).toBe(
      "/?salary=listed"
    );
  });

  it("sends Stripe webhooks to the backend, never the page cache", () => {
    expect(edgeRouteOf("/webhooks/stripe")).toBe("backend");
    expect(edgeRouteOf("/pricing")).toBe("public");
  });
});

describe("billing updates", () => {
  it("fetches the plans on sale at start and keeps them once loaded", () => {
    const started = init();

    const fetched = update(
      started.model,
      Message.CompletedFetchPlans({ plans: offers })
    );

    expect(commandNames(started)).toEqual(["FetchPlans"]);
    expect(Schema.is(PlansState.Loading)(started.model.plans)).toBe(true);
    expect(fetched.model.plans).toEqual(PlansState.Loaded({ plans: offers }));
  });

  it("starts one checkout even when a plan is clicked twice", () => {
    const first = update(
      loaded(free),
      Message.ClickedChoosePlan({ plan: "Yearly" })
    );

    const second = update(
      first.model,
      Message.ClickedChoosePlan({ plan: "Yearly" })
    );

    expect(commandNames(first)).toEqual(["StartCheckout"]);
    expect(Schema.is(BillingAction.Redirecting)(first.model.action)).toBe(true);
    expect(commandNames(second)).toEqual([]);
  });

  it("keeps asking for the plan after checkout until Pro shows up, then stops", () => {
    const waiting = { ...loaded(free), pollsLeft: 2 };

    const stillFree = update(
      waiting,
      Message.CompletedFetchMembership({ membership: Option.some(free) })
    );

    const nowPro = update(
      stillFree.model,
      Message.CompletedFetchMembership({ membership: Option.some(pro) })
    );

    expect([commandNames(stillFree), stillFree.model.pollsLeft]).toEqual([
      ["PollMembership"],
      1,
    ]);
    expect([commandNames(nowPro), nowPro.model.pollsLeft]).toEqual([[], 0]);
  });

  it("gives up polling after the last try and keeps the plan it already showed", () => {
    const last = update(
      { ...loaded(free), pollsLeft: 1 },
      Message.CompletedFetchMembership({ membership: Option.some(free) })
    );

    const failed = update(
      last.model,
      Message.CompletedFetchMembership({ membership: Option.none() })
    );

    expect(commandNames(last)).toEqual(["PollMembership"]);
    expect(failed.model.membership).toEqual(
      MembershipState.Loaded({ membership: free })
    );
    expect(failed.model.pollsLeft).toBe(0);
  });

  it("shows a refused action instead of failing silently", () => {
    const refused = update(
      loaded(free),
      Message.FailedBillingAction({ message: "Instant alerts come with Pro." })
    );

    expect(refused.model.action).toEqual(
      BillingAction.Problem({ message: "Instant alerts come with Pro." })
    );
  });

  it("asks for the plan once the session is known and polls after a checkout return", () => {
    const started = boardInit(flags, urlAt("/account?checkout=done"));

    const signedIn = boardUpdate(
      started.model,
      BoardMessage.GotAccountMessage({
        message: AccountMessage.CompletedFetchSession({
          account: Option.some(ada),
        }),
      })
    );

    expect(started.model.billing.pollsLeft).toBe(CHECKOUT_POLLS);
    expect(commandNames(signedIn)).toContain("FetchMembership");
    expect(
      Schema.is(MembershipState.Loading)(signedIn.model.billing.membership)
    ).toBe(true);
  });

  it.each(["membership", "signout"] as const)(
    "clears every paid filter after confirmed %s loss without leaving the account page",
    (reason) => {
      const board = boardInit(flags, urlAt("/account")).model;

      const filters = {
        ...defaultFilters,
        salaryFloor: { amount: 200_000, currency: "USD" },
        salaryListed: true,
        seniorities: ["Director"],
      } as const;

      const before = {
        ...board,
        account: {
          ...board.account,
          session: SessionState.SignedIn({ account: ada }),
        },
        billing: loaded(pro),
        filters,
      };

      const lost = boardUpdate(
        before,
        reason === "membership"
          ? BoardMessage.GotBillingMessage({
              message: Message.CompletedFetchMembership({
                membership: Option.some(free),
              }),
            })
          : BoardMessage.GotAccountMessage({
              message: AccountMessage.CompletedFetchSession({
                account: Option.none(),
              }),
            })
      );

      expect(lost.model.filters).toEqual(defaultFilters);
      expect(lost.model.route).toEqual(before.route);
      expect(commandNames(lost)).toContain("FetchJobs");
      expect(commandNames(lost)).not.toContain("PushUrl");
      expect(commandNames(lost)).not.toContain("ReplaceUrl");
    }
  );

  it.each([
    { salaryListed: true },
    { salaryFloor: { amount: 200_000, currency: "CAD" } },
    { seniorities: ["Director"] },
  ] as const)(
    "refetches anonymous preloads when Pro is confirmed for %o",
    (refinement) => {
      const filters = { ...defaultFilters, ...refinement };

      const started = boardInit(
        {
          ...flags,
          preload: Preload.Board({
            filters,
            generatedAt: 1,
            jobs: [],
            total: 0,
          }),
        },
        urlAt(boardUrl(filters))
      );

      const signedIn = boardUpdate(
        started.model,
        BoardMessage.GotAccountMessage({
          message: AccountMessage.CompletedFetchSession({
            account: Option.some(ada),
          }),
        })
      );

      const confirmed = boardUpdate(
        signedIn.model,
        BoardMessage.GotBillingMessage({
          message: Message.CompletedFetchMembership({
            membership: Option.some(pro),
          }),
        })
      );

      const repeated = boardUpdate(
        confirmed.model,
        BoardMessage.GotBillingMessage({
          message: Message.CompletedFetchMembership({
            membership: Option.some(pro),
          }),
        })
      );

      expect(commandNames(started)).not.toContain("FetchJobs");
      expect(commandNames(confirmed)).toContain("FetchJobs");
      expect(confirmed.model.generation).toBe(signedIn.model.generation + 1);
      expect(confirmed.model.filters).toEqual(filters);
      expect(commandNames(confirmed)).not.toContain("PushUrl");
      expect(commandNames(confirmed)).not.toContain("ReplaceUrl");
      expect(commandNames(repeated)).not.toContain("FetchJobs");
    }
  );

  it("preserves requested paid filters while membership is loading", () => {
    const board = boardInit(
      flags,
      urlAt("/?pay=200000&level=director&salary=listed")
    ).model;

    const before = {
      ...board,
      billing: {
        ...board.billing,
        membership: MembershipState.Loading(),
      },
    };

    const waiting = boardUpdate(
      before,
      BoardMessage.GotBillingMessage({
        message: Message.FailedBillingAction({ message: "Try again." }),
      })
    );

    expect(waiting.model.filters).toEqual(before.filters);
    expect(waiting.model.filters.salaryFloor).toEqual({
      amount: 200_000,
      currency: "USD",
    });
    expect(waiting.model.filters.salaryListed).toBe(true);
    expect(waiting.model.filters.seniorities).toEqual(["Director"]);
    expect(commandNames(waiting)).toEqual([]);
  });

  it("forgets the plan when the member signs out", () => {
    const board = {
      ...boardInit(flags, urlAt("/")).model,
      billing: loaded(pro),
    };

    const signedOut = boardUpdate(
      {
        ...board,
        account: {
          ...board.account,
          session: SessionState.SignedIn({ account: ada }),
        },
      },
      BoardMessage.GotAccountMessage({
        message: AccountMessage.CompletedFetchSession({
          account: Option.none(),
        }),
      })
    );

    expect(signedOut.model.billing).toEqual({
      ...init().model,
      plans: PlansState.Loaded({ plans: offers }),
    });
  });
});

describe("billing pages", () => {
  it("saves against the dearest plan per day", () => {
    expect(offers.map((offer) => savingOf(offer, offers))).toEqual([
      { against: "Weekly", percent: 0 },
      { against: "Weekly", percent: 13 },
      { against: "Weekly", percent: 43 },
    ]);
  });

  it.effect(
    "shows each configured Pro plan with its interval to a signed-out visitor",
    () =>
      Effect.map(
        renderAs("/pricing", SessionState.SignedOut(), Option.none()),
        (html) => {
          const text = textOf(html);

          expect(text).toContain("$5 / week");
          expect(text).toContain("$19 / month");
          expect(text).toContain("$149 / year");
          expect(text).toContain("Save 13% against weekly");
          expect(text).toContain("Salary floor and seniority filters");
          expect(text).not.toContain(
            "Salary floor and seniority filters coming soon"
          );
          expect(text).toContain("Company intel");
          expect(text).not.toContain("Company intel coming soon");
          expect(text.match(/Sign in to upgrade/gu)?.length).toBe(3);
        }
      )
  );

  it.effect("renders a single weekly plan as five dollars a week", () =>
    Effect.map(
      renderAs("/pricing", SessionState.SignedOut(), Option.none(), [
        {
          amountCents: 500,
          interval: "week",
          intervalCount: 1,
          plan: "Weekly",
        },
      ]),
      (html) => {
        const text = textOf(html);

        expect(text).toContain("Weekly $5 / week Cancel any time");
        expect(text.match(/Sign in to upgrade/gu)?.length).toBe(1);
      }
    )
  );

  it.effect(
    "hides plans, checkout and the pricing tab when the site sells no plans",
    () =>
      Effect.map(
        renderAs(
          "/pricing",
          SessionState.SignedIn({ account: ada }),
          Option.some(free),
          []
        ),
        (html) => {
          const text = textOf(html);

          expect(text).toContain("Pro is not on sale on this site.");
          expect(text).not.toContain("Choose");
          expect(text).not.toContain("Stripe handles payment");
          expect(text).not.toContain("Upgrade");
        }
      )
  );

  it.effect(
    "drops the Pro upsell from a Free account when no plans are on sale",
    () =>
      Effect.map(
        renderAs(
          "/account",
          SessionState.SignedIn({ account: ada }),
          Option.some(free),
          []
        ),
        (html) => {
          const text = textOf(html);

          expect(text).toContain("You are on Free.");
          expect(text).not.toContain("Pro adds instant alerts");
        }
      )
  );

  it.effect(
    "keeps every role on the board and offers Pro when a Free member turns on the salary filter",
    () =>
      Effect.map(
        renderAs(
          "/?salary=listed",
          SessionState.SignedIn({ account: ada }),
          Option.some(free)
        ),
        (html) => {
          const text = textOf(html);

          expect(text).toContain("These selections are not applied on Free.");
          expect(text).toContain("Upgrade");
        }
      )
  );

  it.effect(
    "offers Pro for salary-floor and seniority selections from a shared link",
    () =>
      Effect.map(
        renderAs(
          "/?pay=200000&level=director",
          SessionState.SignedIn({ account: ada }),
          Option.some(free)
        ),
        (html) => {
          expect(textOf(html)).toContain(
            "These selections are not applied on Free."
          );
          expect(textOf(html)).toContain("See Pro plans");
        }
      )
  );

  it.effect("badges a Pro member and drops the upgrade prompt", () =>
    Effect.map(
      renderAs(
        "/?salary=listed",
        SessionState.SignedIn({ account: ada }),
        Option.some(pro)
      ),
      (html) => {
        const text = textOf(html);

        expect(html).toContain('aria-label="Your plan: Pro"');
        expect(text).not.toContain("Salary filters come with Pro");
        expect(text).not.toContain("Upgrade");
      }
    )
  );

  it.effect(
    "shows a Pro member's renewal date, instant alerts and billing link",
    () =>
      Effect.map(
        renderAs(
          "/account",
          SessionState.SignedIn({ account: ada }),
          Option.some(pro)
        ),
        (html) => {
          const text = textOf(html);

          expect(text).toContain(
            "You have Pro monthly. It renews on November 18, 2026."
          );
          expect(text).toContain("Instant alerts on");
          expect(text).toContain("Manage billing");
        }
      )
  );
});
