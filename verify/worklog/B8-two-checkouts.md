# B8: two Stripe checkouts from one click path

## The bug

You choose a plan on Pricing. While Stripe is still opening, you go to your account page and come back to Pricing. The button is active again, and a second click starts a second checkout. A double click on one visit was already safe. Leaving the page and coming back was not.

## How we found it

The `client-billing` TLA+ model has the rule OneCheckoutAtATime. TLC found a path that broke it. The path chose a plan, entered the account page, came back, and chose again. In the code, `entered` reset `action` to `Idle` on every page entry. That reset cleared the Redirecting guard while the first checkout was still in flight. The model test in `state-machines.billing.test.ts` counted two `StartCheckout` commands on that path.

## The fix

`ClickedChoosePlan` and `ClickedManageBilling` now start a request only when the action is at rest, meaning `Idle` or `Problem`. `Problem` still counts as at rest because the error has already arrived and the plan buttons are clickable, so a retry must work. When you enter a page, only a shown `Problem` is cleared. A `Redirecting` or `Saving` action stays as it is until its reply arrives.

## Lesson

Resetting state when a page is entered feels tidy, but it can also clear a guard that protects a request still in flight. Before writing a reset, ask which of the states it clears belong to an outstanding request.
