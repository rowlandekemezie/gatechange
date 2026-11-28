# S3: a second checkout before the first payment lands (not fixed yet)

## The bug

You pay for Pro in one tab. Stripe has charged you, but its webhook has not reached us yet. In a second tab you press Upgrade again. The server still sees a free account, so it opens a second checkout session, and you could pay twice.

## How we found it

The `server-checkout` TLA+ model checks ChargedForOneProAtMost. TLC found the gap between "Stripe took the money" and "our webhook stored the subscription". The job-store model test presses Upgrade twice before delivering any webhook. It sees two checkout sessions.

## Why it is not fixed in this PR

To refuse or reuse the second checkout, the server must remember that it opened the first one. No current table holds that fact. `subscriptions` is for rows Stripe reported, and `billing_customers.linked_at` records when the customer was linked. Putting a fake row in either table would make the data lie. The honest fix needs an additive migration. This run's rules say to stop and report instead of adding one.

The proposed shape is a table `checkout_starts (account_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL)`. `startCheckout` would run one guarded upsert: `INSERT ... ON CONFLICT (account_id) DO UPDATE SET started_at = excluded.started_at WHERE checkout_starts.started_at < ?`, where `?` is now minus the Stripe session lifetime. The server would create a session only when `changes = 1`. That keeps the guard inside the write. A Stripe idempotency key per account and window would also cover concurrent clicks.

## Lesson

Some guards need state that the schema does not have yet. Say so, rather than storing the state somewhere it does not belong.
