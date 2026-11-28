# B2 and B3: tracker writes race each other

## The bugs

B2: on a shortlist card, you pick "Applied" and then quickly pick "Interviewing". The card shows Interviewing. Reload, and it says Applied.

B3: you press "Move them to your account", and while the move runs you save another job. The button stays on "Moving…" for good.

## How we found them

The TLA+ model `verify/tla/client-tracker-changes` sends each stage pick as its own request and lets the Worker run them in either order. TLC found a path that breaks SettledCardMatchesServer. `client-tracker-session` broke MovingOnlyWhileMoving the same way: the save raised `trackerRevision`, so the import's reply looked stale and nothing cleared Moving. Both model traces were replayed against the real `update` in Vitest. Playwright reproduced them by holding one `trackJob` or `importShortlist` request on the network.

## The fix

The tracker now has a write lane, `writes`, inside `TrackerState.Remote`. Stage picks, notes, removals and the shortlist import join it in click order. Only the head is sent. Its reply sends the next write, and the card shows the server list with the waiting writes applied on top. A reply that is not for the head write is ignored. The server applies writes in the order you made them, so it keeps your last pick. The import reply is always the head write when it arrives, so it always clears Moving.

The B2 replay test changed shape with the fix. The old test answered two requests out of order, and with one write at a time the second request is not sent until the first answers, so that order can no longer happen. The new test checks that only one request is in flight, that the first reply sends the second, and that the card ends on the stage the server kept.

## Lesson

"Latest revision wins" protects the screen, not the server. When two writes can reach the server in either order, send them one at a time.
