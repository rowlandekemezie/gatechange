# Operations

Maintainer notes for the production deployment of Gate Change, its persistent preview, and pull request previews. To run your own copy, follow [Run your own](../README.md#run-your-own) instead.

## CI and production deploys

Deploys run from GitHub Actions. Every pull request and push runs the full check, test and build. A push to `main` that passes deploys the `prod` stage and checks that the production site answers. The production host is `SITE_HOSTNAME` in `packages/core/src/site.ts`.

## One-time setup

1. Make sure the zone in `SITE_ZONE` (`packages/core/src/site.ts`) is on your Cloudflare account.
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

The board fills over the first few hours. Each cron run fetches up to 30 due feeds (`DEFAULT_FEEDS_PER_RUN` in `packages/core/src/feed.ts`), so the 415 feeds take about 14 runs.

## Production billing

Pro is sold through Stripe. Production billing needs these settings:

- `BILLING_ENABLED=true`.
- `PRO_PLANS`, a JSON array with one entry per Stripe Price. Production sells one plan: `[{"plan":"Weekly","amountCents":500,"interval":"week"}]`.
- `STRIPE_RESTRICTED_KEY`, an `rk_live_` restricted key with write access to Checkout Sessions, Customers and the Customer portal only. The `prod` deploy refuses `BILLING_ENABLED` without it. Other stages accept only test keys.

Never drop or reprice a plan that has subscribers. To change a price, add a plan with a new name and set `onSale` to `false` on the old one. Existing subscribers renew on the archived price and keep Pro. `.env.example` describes each variable in full.

## Persistent preview

`preview` deploys the same application code as production with separate Website and JobsBackend Workers, D1, queue, authentication sessions, and Stripe test resources. Its stable URL is <https://jobs-preview.rowland-ekemezie.workers.dev>. Production keeps its custom domain and existing defaults. Native Worker version preview URLs do not isolate this application's service bindings, queue consumers, and scheduled tasks.

The persistent `preview` stage uses these defaults; explicit environment configuration can override them. PR stages use the stricter rules below:

| Setting | `preview` | Other stages |
| --- | --- | --- |
| `BILLING_ENABLED` | `true`, test mode required | `false` |
| `PRO_PLANS` | The `preview` environment's `PRO_PLANS` variable in CI | Empty, so no Pro plans |
| `WORKERS_SUBDOMAIN` | `rowland-ekemezie` | Unset |
| `DIGEST_SITE_ORIGIN` | Preview URL above | Production origin |
| `ENRICHMENT_DAILY_NEURONS` | `0` | `29000` |
| `ENRICHMENT_SWEEP_LIMIT` | `0` | `8` on `prod`, otherwise `0` |
| `MAGIC_LINK_DAILY_SEND_LIMIT` | `10` | `900` |
| `DIGEST_DAILY_SEND_LIMIT` | `5` | `50` |
| `DIGEST_SENDS_PER_RUN` | `1` | `25` |

Preview retains ingestion and scheduled mail delivery. Its zero AI budgets prevent automatic model calls, including queued deliveries. Preview mail remains real email, so use test accounts you control. Production's default 950 sends plus preview's 15 leave 35 of the observed 1000-per-day account allowance. These separate D1 budgets are not an atomic cross-database account quota; other stages, callers, overrides, or a changed provider allowance can consume that room. Recheck the account allowance before increasing them. Preview sends use the existing verified sender domain, while login, job, billing, and unsubscribe links use the preview origin.

The `preview` GitHub environment must contain a unique `PREVIEW_BETTER_AUTH_SECRET` (at least 32 characters) and `PREVIEW_STRIPE_TEST_API_KEY` (`sk_test_` or `rk_test_`). Use a different auth secret from production. The preview job explicitly uses the existing repository Cloudflare credentials; it never substitutes production auth or Stripe secrets. OAuth remains disabled until separate preview apps and callback URLs are configured. With no `STRIPE_RESTRICTED_KEY` override, the Worker uses this test profile key for billing; choose a suitably scoped test key.

CI deploys both stages after a successful check on a push to `main`. A manual CI run deploys its selected branch to persistent preview only; select `preview_plan_only` to inspect the plan without deploying. Select `preview_parent_only` to bootstrap only the shared PR backend parent. Preview gets its own deployment concurrency group. It validates both preview secrets before profile creation, stores the Stripe test key through `alchemy profile edit --add Stripe --method stored --set apiKey=- --no-input` using stdin, plans, deploys, and checks the homepage, auth health, and crawler exclusions. The profile lives in a private ephemeral `ALCHEMY_HOME` removed on success or failure. Only Alchemy profile/plan/deploy subprocesses use `CI=false`, because the pinned CLI otherwise ignores profiles; checks, tests, and builds retain CI behavior. No `STRIPE_API_KEY` environment fallback is used.

For a local deployment, configure a separate profile with the existing Cloudflare account and a Stripe **test** key. Set a unique `BETTER_AUTH_SECRET` through the declared local configuration before planning:

```sh
pnpm alchemy profile create preview
pnpm alchemy profile edit --profile preview --add Cloudflare
pnpm alchemy profile edit --profile preview --add Stripe
ALCHEMY_PROFILE=preview pnpm infra:plan --stage preview --no-input
ALCHEMY_PROFILE=preview pnpm infra:deploy --stage preview --yes --no-input
```

Review the plan before deploying: preview should create or update only its stage-owned resources, with its own D1 and queue, Stripe test objects and webhook, and no production-domain or production-database change. Keep credentials out of command arguments and logs. If running these Alchemy commands inside a CI environment, scope `CI=false` to those subprocesses so the stored Stripe profile can resolve.

Every non-production stage routes pages and static assets through the Worker so they receive `X-Robots-Tag: noindex`; production retains its selected Worker paths and direct asset serving. Preview disallows crawling in `robots.txt`, and has no sitemap entries. These crawler signals do not restrict access: the preview is public, and private account data still requires its own preview session.

## Pull request previews

Same-repository PRs deploy after the full CI gate passes. Each PR gets stable [Cloudflare native Worker Previews](https://developers.cloudflare.com/workers/previews/) for Website and JobsBackend. Website uses the persistent preview Website as its parent. Backend Previews use one shared `jobs-pr-backend` parent. The frontend URL is `https://pr-<number>-jobs-preview.rowland-ekemezie.workers.dev`. GitHub shows it in deployments and in one bot comment updated after each successful deployment, with the deployed commit. Fork PRs run CI without deployment credentials.

PR code uses the persistent preview D1 and queue bindings, never production data. Cloudflare does not automatically isolate D1 data per Preview; shared preview accounts and edits are visible across PRs. Only the persistent preview owns migrations, ingestion, queue consumption and scheduled delivery. Schema changes that cannot coexist with the shared preview schema need a separate data migration plan. PRs cannot enable Checkout, scheduled mail or AI spend; test Stripe Checkout on the persistent preview.

[Service bindings reach the parent's normal deployment](https://developers.cloudflare.com/workers/previews/resources/), so Website forwards to its matching backend Preview over HTTPS. A per-PR credential protects that endpoint before application routing. The backend restores the exact configured PR website origin for auth and reports its PR stage in the smoke test. Preview credentials remain server-side. The shared backend parent serves only a denial response and enables preview routing while its stable public URL stays disabled. Its historical versions contain no application endpoints. This leaves the existing preview backend and its historical versions private. The existing preview environment auth secret supplies both auth and a separately derived transport credential; no extra GitHub secrets are needed.

Closing or merging a PR removes only its two native Previews through Alchemy, retires the deployment link and updates the comment. Cleanup runs trusted base code, shares the PR deployment lock and validates the `pr-N` stage and refuses cleanup unless its state contains only Website, JobsBackend and stack outputs. The persistent preview Workers, shared backend parent, D1, queue and production resources remain owned by their existing stages. Deployment checks the current PR state before writing, so a completed CI run cannot recreate a closed PR's preview.

## Search visibility and public information

The homepage, pricing, job, company, role and information pages render HTML at the edge using the same Foldkit program as the browser. The homepage preloads one bounded page of public listings. It does not forward a visitor's credentials to the backend. Account pages remain private and are never server-rendered or shared in the page cache.

Filtered homepage URLs preserve the selected filters for sharing and browser history, but carry `noindex` and `private, no-store`. The unfiltered homepage and curated job/company/role pages remain the discovery paths. A sitemap fetch does not imply that Google or Bing has indexed its entries. Sitemap dates are omitted because a feed's last successful observation is not a content-change timestamp.

To measure indexing, use an owner-verified [Google Search Console](https://search.google.com/search-console) and [Bing Webmaster Tools](https://www.bing.com/webmasters/) property for the production origin. Submit `/sitemap.xml` and inspect the homepage, one current job, one company and one role URL. Check the rendered content, selected canonical and indexing status. Verify an arbitrary filtered homepage is excluded and preview remains excluded. Property verification requires access to the owner's search accounts; it is separate from deployment smoke tests.

Public `/about`, `/privacy`, `/terms` and `/contact` pages describe coverage, data handling and support. Account deletion is currently a manual support request, with a link from the account page. It is not an automated deletion flow or subscription cancellation. Google for Jobs markup remains subject to source permission and complete, accurate job data; public-page rendering does not relax those requirements.

## Workers plan

Workers Paid ($5 a month) is recommended. Workers Free limits each cron run to 50 subrequests and 10 ms of CPU, which is not enough to parse the default 30 job boards a run. On Free, deploy with `INGEST_FEEDS_PER_RUN=8` in `.env.local` (or the shell) so each run stays inside those limits.
