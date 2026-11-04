# Vision

jobs.rowlandekemezie.com is a job board for engineering leaders who are looking for their next role. It lists engineering manager, director, head of engineering, and VP of engineering openings that are remote in Canada, remote in the US, or based in Vancouver and British Columbia. Every listing is free and public, and every listing links to the original posting.

The board started as a personal tool. It is becoming a product with a paid tier, Gate Change Pro. Pro sells speed, sharper filters, and company intel. It never sells access to a listing.

`AGENTS.md` is the law for commands, architecture, and the fence. This file sets intent. If the two disagree, `AGENTS.md` wins, and this file gets amended.

## Who it is for

The customer is the engineering leader running their own job search. They manage people today, or did recently, and they want leadership roles only. Generic boards bury these roles under hundreds of individual-contributor postings and stale reposts.

What this person needs from the board:

- Only leadership titles, filtered by role and by where they can work.
- The freshest roles first, with long-open roles still findable. The board admits every role a company's own board lists, however old the posting, admits roles from aggregators only when they were posted in the last 30 days, and ranks by relevance minus age. A role leaves when its company board stops listing it, or 30 days after an aggregator posted it.
- One link to the real posting, preferring the company's own board over an aggregator copy.
- A place to keep a shortlist and track applications.

Employers are not the customer. The board does not sell job posts, featured slots, or candidate data.

## Free and Pro

The free board is the product. Pro makes a search faster and better informed.

Free, forever, with or without an account:

- The full board and every listing on it.
- Search and every role and region filter that exists today.
- The link to apply on the original posting.
- The application tracker.
- A weekly email digest of a saved search.

Pro, with the proposed prices of 19 USD a month, 49 USD a quarter, or 149 USD a year:

- Instant alerts when a new listing matches a saved search.
- Salary and seniority filters.
- Company intel next to a listing, such as hiring history and how long similar roles stayed open.

The prices are proposals. Changing them needs the owner's sign-off.

## Rules the product keeps

**No listing is ever gated.** Every listing the board holds is visible without signing in and without paying. Pro adds features around listings. It never hides, delays, or truncates one. A design that shows a listing to Pro members first, or blurs part of it for free viewers, breaks this rule.

**Every source is used within its published terms.** The board reads public job APIs and aggregator feeds. Each one is fetched no more often than its terms allow, identified with the crawler's `USER_AGENT`, linked back to its original posting, and credited where its terms ask for credit. When a source's terms forbid a use, such as charging for its data or putting it behind a login, the board does not make that use. When a source publishes no terms, the board stays close to what the source shows in public and records the gap. That record is research, not legal advice.

**The domain and regions stay.** The product lives on `jobs.rowlandekemezie.com`. Its regions are remote Canada, remote US, and Vancouver and British Columbia. Adding a region or moving to a new brand is a product decision for the owner.

## How it gets built

The board runs on the rat-stack foundation. Effect owns the program, Alchemy declares the Cloudflare resources in code, and the fence of lint, types, the Effect language service, hooks, and CI makes the easy path the right one. `AGENTS.md` names the pins and the commands.

Each new piece of the product passes the cartridge test:

- **Labeled.** One package, one job, named for that job.
- **Push in.** Adding it takes one package plus one `Layer.provide` or Stack line.
- **Pull out.** Removing it leaves the rest of the board building and passing the gate.

Debt only shrinks. Code that someone touches is finished the rat-stack way, and the old version is deleted. A lint or diagnostics exemption follows `AGENTS.md`: a directive with a reason, at a real boundary.

Behavior is proved on the running board, not only in tests. The project's verify skill at `.claude/skills/verify/` boots the board locally with recorded listings and drives it in a browser. A change to what a person sees ships with a screenshot from that skill.

## Will not do for now

- Gate listings behind a signup. It breaks Remotive's terms, removes the board from Google for Jobs, and weakens the public job pages.
- Charge employers first. Remote Rocketship tried it and found no demand, and employer demand on the Pragmatic Engineer board fell after 2022.
- Sell AI resume tailoring. Himalayas already sells it for 9 USD a month, so it would not set this board apart.
- Take on a new brand or wider regions.
- Sell or share candidate data.

## Merge by default

These changes need no sign-off beyond a clean gate and the review the stack requires:

- A new company board in `packages/job-sources/src/boards.ts`, or a new feed adapter, as `AGENTS.md` allows. The source-terms rule still governs how its listings are used.
- Tests, docs, and verify-skill scenarios.
- Free features that make the board faster to use, as long as no listing moves behind a sign-in.
- A deploy whose `pnpm infra:plan` shows only the intended diff, per `AGENTS.md`.

## Needs sign-off

The owner, Rowland Ekemezie, signs off on these before the work lands:

- Any change that gates, delays, or hides a listing from a free viewer.
- Using a source in a way its published terms do not clearly allow, or adding a source with no published terms to a paid feature.
- Prices, the contents of the free tier, or moving a feature from free to Pro.
- A new domain, brand, or region.
- Dependency version changes, including new dependencies such as an auth or billing library.
- Loosening the lint, diagnostics, or hook fence.
- `pnpm infra:destroy`, and any plan that replaces or deletes the D1 database.
- Paid platform plans and accounts, such as Workers Paid for email or a Stripe account for billing.

`AGENTS.md` also lists, under Boundaries and sign-off, which deploy and infrastructure steps are safe by default and which need sign-off. Every push to `main` deploys prod through CI, so the owner lands each PR.

## Amendment policy

This document changes when the product changes: a new customer, a new tier, a new rule about sources or listings. Agents may propose an amendment with evidence, such as a measured result, a source's published terms, or a user report. The owner approves it. An amendment that contradicts `AGENTS.md` changes `AGENTS.md` in the same PR or does not land.
