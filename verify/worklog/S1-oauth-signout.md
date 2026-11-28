# S1: signing out could leave ChatGPT connected

## The bug, in user words

You connect ChatGPT or Claude to Gate Change, then sign out. You expect that to cut the app off. It usually did. But if the app refreshed its key at the same moment you signed out, it could walk away with a fresh key that still worked. Signing out again would not find it, because the key was no longer tied to any browser session.

## How we found it

A TLA+ model of sign-out and token refresh found the path. Sign-out read the list of live keys, then revoked them in a later step. A refresh could store a new key between those two steps, and the revoke never saw it. Deleting the session then cleared the new key's link to it. We replayed that order against the real better-auth code with a fake D1 that holds each SQL statement until the model says it may run. The test failed the way the model did.

## The fix

Sign-out now runs as one D1 batch, which is a single transaction. It revokes every token linked to the session by session id, not by a list read earlier, and deletes the session row. A refresh that lands after the batch stores its key with a session id that no longer exists, so the foreign key rejects it. A refresh that lands before has a key the batch can see. No order leaves a live key.

## What we learned

Read-then-write over two calls is a race on D1, which has no interactive transactions. The fix removed the gap instead of adding a check. The existing foreign key was already the guard on the refresh side once the session delete moved into the same write.
