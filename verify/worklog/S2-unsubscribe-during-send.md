# S2: an unsubscribe during a send still sent the email

## The bug

You click Unsubscribe in a Gate Change email. A minute later the weekly digest arrives anyway. Instant alerts had the same problem, and switching instant alerts off had it too.

## How we found it

The TLA+ model in `verify/tla/server-digest-send` lets the member unsubscribe at any step of a send run. TLC found a short path: the run checks that the member is still subscribed, the member unsubscribes, and then the run reserves the send. The entity test `state-machines.digest-send.test.ts` replays that order against the real D1 store by slipping an unsubscribe in just before the claim. The digest still went out.

## The fix

A send run works from a list of recipients it read a few seconds earlier. The claim that reserves the send was a single `INSERT ... SELECT ... WHERE` that checked the daily caps but not the subscription. Now the same statement also checks `NOT EXISTS` in `alert_unsubscribes`, and for instant alerts it also checks that the `instant_alerts` row still exists. If the member has left, the insert adds no row, the claim returns false, and the run skips that member. The run already handled a false claim as a skip, so no other code changed.

## What we learned

Reading a list and acting on it later is a race. If D1 decides the check and the write in one statement, nothing can happen between them. An unsubscribe that lands after the claim can still miss that one email. Stopping that would need the mail provider to take part in the transaction. The model now states that limit directly. A send is never reserved after an unsubscribe, and TLC checks that rule on all 810 states.
