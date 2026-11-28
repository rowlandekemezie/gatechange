# B6: a deleted saved search comes back

## The bug

On your account page you delete a saved search. It disappears, and then a moment later it is back in the list. The server did delete it. Reload, and it is gone again.

## How we found it

The TLA+ model `verify/tla/client-saved-searches` lets the list read and the delete overlap. TLC broke DeletedStaysGone when a list read started before the delete and answered after it. The replay in `apps/web/test/state-machines.saved-searches.test.ts` does the same with the real `update`. It opens the account page twice, so the second visit sends a list read, then deletes the search and delivers the old list. In Playwright, the spec held the `savedSearches` reply, deleted the search, and released the reply. The deleted search showed up again.

## The fix

The saved-searches model has a `revision`. It goes up whenever the server's list changes because of this page, after a delete or a save succeeds. `FetchSearches` carries the revision it was sent under, and `CompletedFetchSearches` returns it. A reply with an old revision is not applied. The update sends a new read with the current revision, so the list still reaches the server's state.

## Lesson

A list read is a snapshot of one moment. Once you change the data yourself, a snapshot taken before that change is stale, even if it arrives last. Tag it with the revision it was read under.
