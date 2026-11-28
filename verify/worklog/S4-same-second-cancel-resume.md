# S4: cancel and resume in the same second

## The bug

You cancel Pro in the billing portal, change your mind, and resume within the same second. Stripe sends two `customer.subscription.updated` events with the same `created` second. Depending on their random event ids, your account could say Pro ends at the period end even though you resumed.

## How we found it

The `server-billing-webhook` TLA+ model orders events by (second, type rank, event id), as `applySubscription` does in SQL. TLC found that when the cancel's id sorts after the resume's id, the stored row ends on the cancel. The job-store model test replays the real fixture events with the ids swapped and the resume moved into the cancel's second.

## The fix

The tiebreak now uses information from Stripe instead of chance. Each event's `data.previous_attributes` lists the fields that the event changed. If an update shows the subscription was cancelling before (`cancel_at` set or `cancel_at_period_end` true) and is not cancelling now, it is a resume. A resume cannot happen before the cancel it undoes, so it ranks one above a plain update. The ranks are now created 0, update 1, resume 2, and deleted 3. The SQL guard inside the write is unchanged: it still compares (created, rank, id) in its `WHERE` clause, so ordering stays atomic in D1.

## Lesson

Stripe does not deliver events in order and sends no version number. Before you fall back to a random tiebreak, check what the payload already tells you. Here, the payload records what each event replaced.
