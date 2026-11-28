# B1: a late tracker reply after sign-out deletes a browser job

## The bug

You save a job while signed out, so it lives in your browser. You sign in, then sign out before the page has finished loading your account's tracker. Then you save a second job. Reload the shortlist and the first job is gone.

## How we found it

The TLA+ model `verify/tla/client-tracker-session` checks the rule NoBrowserJobLost. TLC found a short path that breaks it: sign in, sign out, and then the sign-in sync answers. The replay in `apps/web/test/state-machines.tracker-session.test.ts` sent those messages to the real `update` and saw the same thing. The browser list on screen was empty, and the next save wrote a list to `localStorage` without the old job. The Playwright spec `tracker-session` held the `trackedJobs` reply across sign-out, released it, and showed the job missing after a reload.

## The fix

`CompletedSyncTracker` cleared `model.marks` on every reply, including stale ones and ones that arrived after sign-out. The fix makes the handler do nothing unless the tracker is still `Remote` and the reply belongs to it. That means the reply is for the write in flight, or its revision is current. Sign-out swaps the tracker to `Local`, and the write lane lives inside `Remote`, so a reply from the old session has nothing to match.

## Lesson

A reply handler that does "a bit of cleanup" before it checks whether the reply is current is the usual way stale replies cause damage. Check that the reply is still wanted before you change anything.
