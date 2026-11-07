# Operations

Maintainer notes for the production deployment of Gate Change, its persistent preview (UAT), and pull request previews. To run your own copy, follow [Run your own](../README.md#run-your-own) instead.

## CI and production deploys

Deploys run from GitHub Actions. Every pull request and push runs the full check, test and build. A push to `main` that passes deploys the `prod` stage and checks that the production site answers. The production host is `SITE_HOSTNAME` in `packages/core/src/site.ts`.

## One-time setup

1. Make sure the zones of `SITE_HOSTNAME` and every `SITE_REDIRECT_HOSTNAMES` entry (`packages/core/src/site.ts`) are on your Cloudflare account.
2. Create an `admin` Alchemy profile with your Cloudflare **Global API Key** (it must be allowed to create API tokens), and sign in to GitHub with `gh auth login`:

   ```sh
   pnpm alchemy profile create admin
   pnpm alchemy profile edit --profile admin --add Cloudflare
   ```

3. Mint the CI token and write it into this repo's secrets:

   ```sh
   pnpm infra:ci-credentials --profile admin
   ```

   This creates a Cloudflare token scoped to Workers, D1, the state store and your zones' DNS and Workers routes, then stores `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets. Re-run it to rotate the token.

4. Push to `main`, or run the CI workflow by hand from the Actions tab.

## Deploy production from your machine

```sh
export ALCHEMY_PROFILE=<profile name>
pnpm infra:plan --stage prod
pnpm infra:deploy --stage prod
```

Alchemy creates the D1 database and applies `packages/job-store/migrations/`, deploys `JobsBackend` with its cron trigger, builds the Foldkit site, and attaches `SITE_HOSTNAME` as a Worker custom domain.

The board fills over the first few hours. Each cron run fetches up to 60 due feeds (`DEFAULT_FEEDS_PER_RUN` in `packages/core/src/feed.ts`), so the 1,067 feeds take about 18 runs.

## Production billing

Prod sells Pro by default, so the deploy also needs `PRO_PLANS`, a live Stripe key on the profile or in `STRIPE_API_KEY`, and an `rk_live_` key in `STRIPE_RESTRICTED_KEY`. Without `PRO_PLANS` it refuses to deploy rather than archive the live prices. Set `BILLING_ENABLED=false` to deploy prod without billing. In CI these come from the `production` environment's `PRO_PLANS` variable and `STRIPE_LIVE_API_KEY` and `STRIPE_LIVE_RESTRICTED_KEY` secrets.

Pro is sold through Stripe. Production billing needs these settings:

- `BILLING_ENABLED=true`.
- `PRO_PLANS`, a JSON array with one entry per Stripe Price. Production sells one plan: `[{"plan":"Weekly","amountCents":500,"interval":"week"}]`.
- `STRIPE_RESTRICTED_KEY`, an `rk_live_` restricted key with write access to Checkout Sessions, Customers and the Customer portal only. The `prod` deploy refuses `BILLING_ENABLED` without it. Other stages accept only test keys.

Never drop or reprice a plan that has subscribers. To change a price, add a plan with a new name and set `onSale` to `false` on the old one. Existing subscribers renew on the archived price and keep Pro. `.env.example` describes each variable in full.

## Persistent preview

`preview` deploys the same application code as production with separate Website and JobsBackend Workers, D1, queue, authentication sessions, and Stripe test resources. Its stable URL is <https://uat.gatechange.dev>, attached as a Worker custom domain to the existing `jobs-preview` Worker (`UAT_HOSTNAME` in `packages/core/src/site.ts`, `siteRouting` in `apps/infra/src/site-routing.ts`). Production keeps its own custom domains and defaults. Native Worker version preview URLs do not isolate this application's service bindings, queue consumers, and scheduled tasks.

The persistent `preview` stage uses these defaults; explicit environment configuration can override them. PR stages use the stricter rules below:

| Setting | `preview` | Other stages |
| --- | --- | --- |
| `BILLING_ENABLED` | `true`, test mode required | `true` on `prod`, live mode required, otherwise `false` |
| `PRO_PLANS` | The `preview` environment's `PRO_PLANS` variable in CI | The `production` environment's `PRO_PLANS` variable on `prod`, required; otherwise empty, so no Pro plans |
| `WORKERS_SUBDOMAIN` | `rowland-ekemezie` | Unset |
| `DIGEST_SITE_ORIGIN` | `https://uat.gatechange.dev` | Production origin |
| `ENRICHMENT_DAILY_NEURONS` | `0` | `29000` |
| `ENRICHMENT_SWEEP_LIMIT` | `0` | `8` on `prod`, otherwise `0` |
| `MAGIC_LINK_DAILY_SEND_LIMIT` | `10` | `900` |
| `DIGEST_DAILY_SEND_LIMIT` | `5` | `50` |
| `DIGEST_SENDS_PER_RUN` | `1` | `25` |

Preview retains ingestion and scheduled mail delivery. Its zero AI budgets prevent automatic model calls, including queued deliveries. Preview mail remains real email, so use test accounts you control. Production's default 950 sends plus preview's 15 leave 35 of the observed 1000-per-day account allowance. These separate D1 budgets are not an atomic cross-database account quota; other stages, callers, overrides, or a changed provider allowance can consume that room. Recheck the account allowance before increasing them. Preview sends use the existing verified sender domain, while login, job, billing, and unsubscribe links use the preview origin.

The `preview` GitHub environment must contain a unique `PREVIEW_BETTER_AUTH_SECRET` (at least 32 characters) and `PREVIEW_STRIPE_TEST_API_KEY` (`sk_test_` or `rk_test_`). Use a different auth secret from production. The preview job explicitly uses the existing repository Cloudflare credentials; it never substitutes production auth or Stripe secrets. OAuth stays off until the `preview` environment has `PREVIEW_GH_OAUTH_CLIENT_ID` and `PREVIEW_GH_OAUTH_CLIENT_SECRET`, or `PREVIEW_GOOGLE_CLIENT_ID` and `PREVIEW_GOOGLE_CLIENT_SECRET`, and the provider lists the UAT callback (`https://uat.gatechange.dev/api/auth/callback/github` or `/google`). The preview job never reads the production OAuth secrets. With no `STRIPE_RESTRICTED_KEY` override, the Worker uses this test profile key for billing; choose a suitably scoped test key.

CI deploys both stages after a successful check on a push to `main`. A manual CI run deploys its selected branch to persistent preview only; select `preview_plan_only` to inspect the plan without deploying. Select `preview_parent_only` to bootstrap only the shared PR backend parent. Preview gets its own deployment concurrency group. It validates both preview secrets before profile creation, stores the Stripe test key through `alchemy profile edit --add Stripe --method stored --set apiKey=- --no-input` using stdin, plans, deploys, and checks the homepage, auth health, the old URL's redirect, and crawler exclusions. The checks retry for 5 minutes, because the first attach waits for a certificate. The profile lives in a private ephemeral `ALCHEMY_HOME` removed on success or failure. Only Alchemy profile/plan/deploy subprocesses use `CI=false`, because the pinned CLI otherwise ignores profiles; checks, tests, and builds retain CI behavior. No `STRIPE_API_KEY` environment fallback is used.

For a local deployment, configure a separate profile with the existing Cloudflare account and a Stripe **test** key. Set a unique `BETTER_AUTH_SECRET` through the declared local configuration before planning:

```sh
pnpm alchemy profile create preview
pnpm alchemy profile edit --profile preview --add Cloudflare
pnpm alchemy profile edit --profile preview --add Stripe
ALCHEMY_PROFILE=preview pnpm infra:plan --stage preview --no-input
ALCHEMY_PROFILE=preview pnpm infra:deploy --stage preview --yes --no-input
```

Review the plan before deploying: preview should create or update only its stage-owned resources, with its own D1 and queue, Stripe test objects and webhook, and no production-domain or production-database change. The `Website` must show an update, not a replacement, because PR previews use it as their parent. Keep credentials out of command arguments and logs. If running these Alchemy commands inside a CI environment, scope `CI=false` to those subprocesses so the stored Stripe profile can resolve.

Every non-production stage routes pages and static assets through the Worker so they receive `X-Robots-Tag: noindex`; production retains its selected Worker paths and direct asset serving. Preview disallows crawling in `robots.txt`, and has no sitemap entries. These crawler signals do not restrict access: the preview is public, and private account data still requires its own preview session. Indexing follows the stage (`SITE_INDEXING`), never the hostname, so `uat.gatechange.dev` stays closed.

The old URL, `https://jobs-preview.rowland-ekemezie.workers.dev`, answers with a redirect to the same path and query on `https://uat.gatechange.dev`: 301 for GET and HEAD, 308 for other methods. `/unsubscribe` and `/webhooks/stripe` are not redirected, so unsubscribe links in sent mail keep working. The `jobs-preview` Worker must keep its `workers.dev` subdomain, because PR previews are served from it. The rule matches that one hostname, so `pr-<number>-jobs-preview` hosts are untouched.

`uat.gatechange.dev` is same-site with `gatechange.dev`, unlike the old URL, so browsers send a `gatechange.dev` session cookie on requests that a UAT page makes to production. `isCrossSite` refuses those on `/rpc`, and better-auth refuses the UAT origin. Session cookies stay host-only: never set a cookie `Domain` or better-auth's `crossSubDomainCookies`, which would share them across both hosts. UAT runs real auth, so the auth secret must differ from production's.

## Pull request previews

Same-repository PRs labelled `preview` deploy after the full CI gate passes. Adding the label deploys a PR that is already open. Keep the label until the PR closes, because the clean-up workflow only removes previews from labelled PRs. Each labelled PR gets stable [Cloudflare native Worker Previews](https://developers.cloudflare.com/workers/previews/) for Website and JobsBackend. Website uses the persistent preview Website as its parent. Backend Previews use one shared `jobs-pr-backend` parent. The frontend URL is `https://pr-<number>-jobs-preview.rowland-ekemezie.workers.dev`. GitHub shows it in deployments and in one bot comment updated after each successful deployment, with the deployed commit. Fork PRs run CI without deployment credentials.

PR code uses the persistent preview D1 and queue bindings, never production data. Cloudflare does not automatically isolate D1 data per Preview; shared preview accounts and edits are visible across PRs. Only the persistent preview owns migrations, ingestion, queue consumption and scheduled delivery. Schema changes that cannot coexist with the shared preview schema need a separate data migration plan. PRs cannot enable Checkout, scheduled mail or AI spend; test Stripe Checkout on the persistent preview.

[Service bindings reach the parent's normal deployment](https://developers.cloudflare.com/workers/previews/resources/), so Website forwards to its matching backend Preview over HTTPS. A per-PR credential protects that endpoint before application routing. The backend restores the exact configured PR website origin for auth and reports its PR stage in the smoke test. Preview credentials remain server-side. The shared backend parent serves only a denial response and enables preview routing while its stable public URL stays disabled. Its historical versions contain no application endpoints. This leaves the existing preview backend and its historical versions private. The existing preview environment auth secret supplies both auth and a separately derived transport credential; no extra GitHub secrets are needed.

Closing or merging a PR removes only its two native Previews through Alchemy, retires the deployment link and updates the comment. Cleanup runs trusted base code, shares the PR deployment lock and validates the `pr-N` stage and refuses cleanup unless its state contains only Website, JobsBackend and stack outputs. The persistent preview Workers, shared backend parent, D1, queue and production resources remain owned by their existing stages. Deployment checks the current PR state before writing, so a completed CI run cannot recreate a closed PR's preview.

## Search visibility and public information

The homepage, pricing, job, company, role and information pages render HTML at the edge using the same Foldkit program as the browser. The homepage preloads one bounded page of public listings. It does not forward a visitor's credentials to the backend. Account pages remain private and are never server-rendered or shared in the page cache.

Filtered homepage URLs preserve the selected filters for sharing and browser history, but carry `noindex` and `private, no-store`. The unfiltered homepage and curated job/company/role pages remain the discovery paths. A sitemap fetch does not imply that Google or Bing has indexed its entries. Sitemap dates are omitted because a feed's last successful observation is not a content-change timestamp.

To measure indexing, use an owner-verified [Google Search Console](https://search.google.com/search-console) and [Bing Webmaster Tools](https://www.bing.com/webmasters/) property for the production origin. Submit `/sitemap.xml` and inspect the homepage, one current job, one company and one role URL. Check the rendered content, selected canonical and indexing status. Verify an arbitrary filtered homepage is excluded and preview remains excluded. Property verification requires access to the owner's search accounts; it is separate from deployment smoke tests.

Public `/about`, `/privacy`, `/terms` and `/contact` pages describe coverage, data handling and support. Account deletion is currently a manual support request, with a link from the account page. It is not an automated deletion flow or subscription cancellation. Google for Jobs markup remains subject to source permission and complete, accurate job data; public-page rendering does not relax those requirements.

## Product analytics

The board sends product events to PostHog through the `/ingest` proxy. Analytics stay off when the stage has no `POSTHOG_PROJECT_KEY`, and a browser that sends Do Not Track or Global Privacy Control sends nothing. Analytics set no cookie and store no id, so each page load gets a new random anonymous id. Anonymous ids therefore count visits, not people, and dashboard labels say visits.

The client also stays off on any page that is not https, except on `localhost`, where local stages run over http, and for an automated renderer that seeds its random numbers, so every id it makes ends in `-772e-84d9-91a3b005d5fc`. Dashboards apply the same two exclusions in `SITE_SCOPE`, because events from before the client change stay in PostHog. To rename a managed insight, set `formerName` so `pnpm posthog:dashboards` renames it in place instead of adding a second tile.

Browser events wait in memory until the session check answers, so a signed-in visitor's first page view carries the account id and an anonymous visitor's carries the random id. If the tab hides first, the events leave as anonymous, and `$identify` merges them if the session answer arrives while the page is still alive. A visitor who closes the tab before the session answer stays anonymous for that page load.

Properties never carry an email, a token, a search string, or a job title. Use counts, lengths, booleans, and enums. Every browser event also has `$pathname`, `$current_url` without the query string, `$session_id`, `$process_person_profile`, the campaign parameters, and the referrer origin.

| Event | Side | Fires when | Properties | Source |
| --- | --- | --- | --- | --- |
| `$pageview` | browser | A route changes, or a visit lands | `route` | `routeEvents`, `events.ts` |
| `$identify` | browser | A visitor signs in after their events already left as anonymous. A reload of a signed-in page sends none | `$anon_distinct_id` | `handle`, `client.ts` |
| `agents_section_viewed` | browser | The `#agents` section scrolls into view | none | `IntersectionObserver`, `client.ts` |
| `apply_clicked` | browser | A click on an apply link | `source`: `board_row`, `job_page` | `applySourceOf`, `client.ts` |
| `checkout_started` | browser | `ClickedChoosePlan` | `plan` | `billingEvents`, `events.ts` |
| `filter_changed` | browser | A filter control changes | `filter`: enum | `FILTERS`, `events.ts` |
| `job_applied` | browser | A job is marked or moved to Applied | none | `messageEvents`, `events.ts` |
| `job_opened` | browser | A job page is entered | none | `routeEvents`, `events.ts` |
| `job_saved` | browser | A job is marked Saved | none | `messageEvents`, `events.ts` |
| `pricing_viewed` | browser | The pricing page is entered | none | `routeEvents`, `events.ts` |
| `search_submitted` | browser | A search is submitted | `query_length` | `messageEvents`, `events.ts` |
| `show_more` | browser | `ClickedLoadMore` | none | `messageEvents`, `events.ts` |
| `signin_completed` | browser | A session appears after a signed-out state or on the confirm page | none | `sessionCalls`, `events.ts` |
| `signup_started` | browser | A sign-in is submitted or a social provider is chosen | `method` | `accountEvents`, `events.ts` |
| `saved_search_created` | browser | `CompletedSaveSearch` with outcome `Saved` | none | `savedSearchEvents`, `events.ts` |
| `instant_alerts_changed` | browser | `CompletedSetInstantAlerts`, the server-confirmed value | `enabled`: boolean | `billingEvents`, `events.ts` |
| `agent_token_created` | browser | `CompletedIssueToken` | none | `agentTokenEvents`, `events.ts` |
| `agent_token_revoked` | browser | `CompletedRevokeToken` with `ok` true | none | `agentTokenEvents`, `events.ts` |
| `search_no_results` | browser | The board settles on zero results, from a fetch, an empty selection, or a served landing page | `query_length`, `filter_count`, `empty_selection`: true when no role or no region is selected, with no fetch | `emptyBoardEvents`, `events.ts` |
| `job_not_found` | browser | A job page settles as missing, from a served landing page or an in-app fetch | none | `missingJobEvents`, `events.ts` |
| `listing_not_found` | browser | A company or role page settles with zero jobs, from a served landing page or an in-app fetch | `kind`: `company`, `role` | `emptyListingEvents`, `events.ts` |
| `read_rate_limited` | browser | A `/rpc` request answers 429 in a real browser. One event per request | none | `checkedHttp`, `board/queries.ts` |
| `mcp_tool_called` | server | An MCP `tools/call` completes | `tool` | `trackedMcpHttp`, `apps/api/src/worker.ts` |
| `subscription_activated` | server | Stripe links a customer. Sent as the account, with a person profile | none | `stripeWebhook`, `apps/api/src/worker.ts` |
| `digest_sent` | server | The digest cron sent at least one email. Sent as `jobs-api` | `count` | digest cron, `apps/api/src/worker.ts` |
| `email_unsubscribed` | server | A `POST /unsubscribe` succeeds, unless the request carries `DNT: 1` or `Sec-GPC: 1`. Sent as the account, with no person profile. A repeat POST sends it again | none | `unsubscribe`, `apps/api/src/worker.ts` |

Add a browser event to `AnalyticsEvent` and `eventNames` in `apps/web/src/client/analytics/events.ts`. Add a server event to `ServerEvent` in `apps/api/src/analytics.ts`, and honor `privacySignalled` when a browser made the request. To check events on a stage, use the `analytics-*` scenarios in the verify skill. They add a stub key in the browser and answer `/ingest` themselves, so no event reaches PostHog.

## Workers plan

Workers Paid ($5 a month) is recommended. Workers Free limits each cron run to 50 subrequests and 10 ms of CPU, which is not enough to parse the default 60 job boards a run. On Free, deploy with `INGEST_FEEDS_PER_RUN=8` in `.env.local` (or the shell) so each run stays inside those limits.
