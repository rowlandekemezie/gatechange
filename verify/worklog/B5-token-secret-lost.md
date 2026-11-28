# B5: a new agent token's secret was never shown

## The bug

You type a label and press Create token. While the token is being created, you go to Roles. When you come back to your account, the new token is in the list, but its secret is gone. A token's secret is shown only once, so you have a token you can never use. You must revoke it and make another one.

## How we found it

The `client-agent-tokens` TLA+ model checks EverySecretShown: every token the server creates had its secret on screen, or the secret is still on its way. TLC broke it in four steps: create, leave, the server answers, come back. In the code, leaving the account page reset the whole token model and bumped its generation. The issue reply then carried an old generation and was dropped. The board also dropped every token message that arrived off the account page.

## The fix

Leaving the page now calls `left`, which keeps an in-flight `Issuing` state and the generation it was sent in. The issue reply is matched to that generation, not to the page visit. If the reply arrives while you are away, the page holds the secret off screen. When you come back, the page shows the secret once. If the account page reloads its list, a secret you already saw is still dropped, and sign-out still drops everything. If the reply arrives after you return, the new token is not listed twice.

## Lesson

A generation counter answers "is this reply still wanted?" That is the right question for a list read. It is the wrong question for a one-time secret, which is always wanted. Key each reply by what it carries, not by one counter for the whole page.
