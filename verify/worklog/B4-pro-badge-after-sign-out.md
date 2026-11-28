# B4: the Pro badge came back after sign-out

## The bug

You are a Pro member. You reload the page and sign out before the page has finished asking the server for your plan. The header says "Sign in", and next to it the Pro badge is back. You are signed out, but the page says you pay for Pro.

## How we found it

The TLA+ model in `verify/tla/client-billing` checks one rule: after sign-out, the header shows no Pro badge. TLC found a short path. The page asks for your plan, you sign out, and then the old answer arrives. The page put the answer in place without asking who had requested it. The model test in `apps/web/test/state-machines.billing.test.ts` replayed that path against the real `update`, and a Playwright test held the `membership` reply in a real browser to show the badge on screen.

## The fix

The billing model now has a `generation` number. Sign-out increases it. Each membership fetch and poll sends the generation it started in, and the reply brings it back. `update` uses a reply only when its generation matches the current one. An answer that started before sign-out is out of date, so the page drops it.

The agent-tokens module already used this pattern. Billing did not, so the fix copies the pattern into billing.

## Lesson

A reply belongs to the request that asked for it. If a reply does not say which session it is for, a slow network can apply it to the wrong session. The model found this bug in a few states. A plain unit test did not, because unit tests deliver replies in order.
