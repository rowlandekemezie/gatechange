import { describe, expect, it } from "@effect/vitest";

import { Message as BillingMessage } from "../src/client/billing/message.js";
import { isProMember } from "../src/client/billing/model.js";
import {
  billing,
  free,
  leftTo,
  membershipArrives,
  named,
  pro,
  sentAll,
  signOut,
  signedIn,
  started,
  walked,
} from "./state-machines.support.js";

const choose = billing(BillingMessage.ClickedChoosePlan({ plan: "Monthly" }));

describe("Billing model replay", () => {
  it("NoProBadgeSignedOut: a membership reply that lands after sign-out does not bring back the Pro badge", () => {
    const ready = sentAll(started("/pricing"), [signedIn]);

    expect(named(ready.commands, "FetchMembership")).toHaveLength(1);

    const out = sentAll(ready, [...signOut, membershipArrives(pro)]);

    expect(isProMember(out.model.billing)).toBe(false);
  });

  it("OneCheckoutAtATime: leaving Pricing and coming back while Stripe opens does not start a second checkout", () => {
    const path = walked(started("/pricing"), [
      signedIn,
      membershipArrives(free),
      choose,
      leftTo("/account"),
      leftTo("/pricing"),
      choose,
    ]);

    expect(named(path.all, "StartCheckout")).toHaveLength(1);
  });

  it("holds OneCheckoutAtATime on a double click: one checkout starts", () => {
    const path = walked(started("/pricing"), [
      signedIn,
      membershipArrives(free),
      choose,
      choose,
    ]);

    expect(named(path.all, "StartCheckout")).toHaveLength(1);
  });

  it("holds BadgeTellsTruth: a free member has no Pro badge", () => {
    const ready = sentAll(started("/pricing"), [
      signedIn,
      membershipArrives(free),
    ]);

    expect(isProMember(ready.model.billing)).toBe(false);
  });

  it("holds NoProBadgeSignedOut on the plain path: signing out clears Pro", () => {
    const out = sentAll(started("/pricing"), [signedIn]);
    const done = sentAll(out, [membershipArrives(pro), ...signOut]);

    expect(isProMember(done.model.billing)).toBe(false);
  });
});
