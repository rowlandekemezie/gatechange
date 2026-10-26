# Engineering leadership jobs

A job board for engineering managers, directors, heads of engineering and VPs of engineering. It collects roles from public company job boards and remote-job aggregators, admits roles posted in the last 30 days, keeps each one while its source still lists it, and opens on the freshest, most relevant roles that are remote in Canada, remote in the US, or in Vancouver and BC.

Live at `jobs.rowlandekemezie.com` once deployed. Built on [rat-stack](https://ratstack.sh): Effect 4, Alchemy on Cloudflare Workers and D1, and a Foldkit UI.

## How it works

```text
cron (every 20 min) ─▶ JobsBackend.runIngest
                         ├─ picks the feeds that are due (oldest first, backoff on failure)
                         ├─ fetches each feed and keeps only leadership titles
                         ├─ upserts what a feed listed, marks what it stopped listing departed
                         └─ prunes roles departed over a day or unseen for 30 days and records a run receipt

browser ─▶ Website ─▶ /rpc ─▶ JobsBackend.listJobs / boardStats ─▶ D1
```

Sources:

- 406 company boards on Greenhouse, Ashby, Lever, SmartRecruiters and Workable (verified list in `packages/job-sources/src/boards.ts`).
- Remote OK, Remotive, Himalayas and Jobicy searches for engineering manager, director and VP roles.
- The monthly Hacker News "Who is hiring?" thread.

Each source has a minimum refresh interval, so busy aggregators are polled every two to six hours. Every listing links to its original posting, and the footer credits the aggregators.

## Run it

You need Node 24.18 and pnpm 11.3 (`corepack enable` picks up the pinned pnpm).

```sh
pnpm install
pnpm fix
pnpm turbo run check test build
```

`pnpm install` refreshes the lockfile for the new packages. `pnpm fix` applies the formatter and safe lint fixes before the first gate.

## Run your own

You can run your own copy of the board on your own Cloudflare account. It is served on your `workers.dev` subdomain, so you do not need a domain. `pnpm self-host` checks your inputs, then runs Alchemy against a new stage that you name. Alchemy creates the D1 database and applies `packages/job-store/migrations/`, creates the enrichment queue, and deploys both Workers with their cron triggers.

A "Deploy to Cloudflare" button cannot do this. The button deploys one Worker, and it needs that Worker's directory to build with no workspace dependencies. This app is two Workers joined by a service binding, and both depend on workspace packages.

1. Install Node 24.18 and pnpm 11.3. Then clone this repository and run `pnpm install`.
2. Give Alchemy your Cloudflare credentials. Either create a profile (`pnpm alchemy profile create mine`, then `pnpm alchemy profile edit --profile mine --add Cloudflare`), or export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Find your account's `workers.dev` subdomain in the dashboard under **Workers & Pages**. Set `SITE_WORKERS_SUBDOMAIN` in `packages/core/src/site.ts` to it. The site trusts its own sign-in host and links only on that subdomain.
4. Copy `.env.example` to `.env.local`. Set `ALCHEMY_PROFILE` (if you made a profile), `WORKERS_SUBDOMAIN`, and `BETTER_AUTH_SECRET` (from `openssl rand -hex 32`). On Workers Free, also set `INGEST_FEEDS_PER_RUN=8`.
5. Preview the plan, then deploy:

   ```sh
   pnpm self-host plan --stage self
   pnpm self-host deploy --stage self
   ```

The site is at `https://jobs-self.<subdomain>.workers.dev`. It fills over the first few cron runs, which run every 20 minutes. The stage names `prod`, `preview` and `pr-<n>` are reserved. To remove everything the stage created, run `pnpm self-host destroy --stage self`.

### Cost

Workers Paid ($5 a month) is recommended. Workers Free also works if you set `INGEST_FEEDS_PER_RUN=8`, because Free allows 50 subrequests per cron run. D1, the queue and the cron triggers are on both plans. Workers AI on Free stops at 10,000 neurons a day, so if you turn on enrichment there, also set `ENRICHMENT_DAILY_NEURONS=10000`.

### Optional features

Each feature is off when you leave its variables empty. Every variable is described in `.env.example`.

- **Search engines.** Every stage except `prod` sends `noindex`. To be indexed, set `SITE_HOSTNAME` and `SITE_ZONE` in `packages/core/src/site.ts` to a zone on your account, then deploy the `prod` stage as in [Deploying from your machine](#deploying-from-your-machine).
- **AI enrichment.** This stage makes no Workers AI calls until you set `ENRICHMENT_SWEEP_LIMIT` (8 is the production value). `ENRICHMENT_DAILY_NEURONS` caps daily spend. The default cap of 29000 keeps a month under about $10.
- **GitHub or Google sign-in.** Set both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, or both Google variables. Leave a pair empty to hide that button.
- **Email sign-in links and saved-search digests.** These need Cloudflare Email Sending on the zone in `SITE_HOSTNAME`. Mail is sent from `sign-in@` and `digest@` that hostname. Without it, the board still works, but emailed sign-in links and digests fail to send.
- **Paid plans.** Set `BILLING_ENABLED=true` and add a Stripe test key to your Alchemy profile (`pnpm alchemy profile edit --profile mine --add Stripe`). Billing is off by default.

The page footer, the about, contact, privacy and terms pages, and the crawler's user agent still name this deployment. To rebrand, edit `packages/core/src/site.ts`, `apps/web/src/features/information/view.ts`, `apps/web/src/client/board/view.ts` and `packages/job-sources/src/http.ts`.

## Deploy to Cloudflare

Deploys run from GitHub Actions. Every pull request and push runs the full check, test and build. A push to `main` that passes deploys the `prod` stage and checks that `jobs.rowlandekemezie.com` answers.

### One-time setup

1. Make sure `rowlandekemezie.com` is a zone on your Cloudflare account.
2. Install and commit the lockfile, since CI installs with `--frozen-lockfile`:

   ```sh
   pnpm install
   git add pnpm-lock.yaml && git commit -m "chore: lock dependencies" && git push
   ```

3. Create an `admin` Alchemy profile with your Cloudflare **Global API Key** (it must be allowed to create API tokens), and sign in to GitHub with `gh auth login`:

   ```sh
   pnpm alchemy profile create admin
   pnpm alchemy profile edit --profile admin --add Cloudflare
   ```

4. Mint the CI token and write it into this repo's secrets:

   ```sh
   pnpm infra:ci-credentials --profile admin
   ```

   This creates a Cloudflare token scoped to Workers, D1, the state store and your zones' DNS and Workers routes, then stores `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets. Re-run it to rotate the token.

5. Push to `main`, or run the CI workflow by hand from the Actions tab.

### Deploying from your machine

```sh
export ALCHEMY_PROFILE=<profile name>
pnpm infra:plan --stage prod
pnpm infra:deploy --stage prod
```

Alchemy creates the D1 database and applies `packages/job-store/migrations/`, deploys `JobsBackend` with its cron trigger, builds the Foldkit site, and attaches `jobs.rowlandekemezie.com`.

The board fills over the first couple of hours: each cron run fetches 20 due feeds, so all 125 feeds are covered after about seven runs.

### Persistent preview

`preview` deploys the same application code as production with separate Website and JobsBackend Workers, D1, queue, authentication sessions, and Stripe test resources. Its stable URL is <https://jobs-preview.rowland-ekemezie.workers.dev>. Production keeps its custom domain and existing defaults. Native Worker version preview URLs do not isolate this application's service bindings, queue consumers, and scheduled tasks.

The persistent `preview` stage uses these defaults; explicit environment configuration can override them. PR stages use the stricter rules below:

| Setting | `preview` | Other stages |
| --- | --- | --- |
| `BILLING_ENABLED` | `true`, test mode required | `false` |
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

### Pull request previews

Same-repository PRs deploy after the full CI gate passes. Each PR gets stable [Cloudflare native Worker Previews](https://developers.cloudflare.com/workers/previews/) for Website and JobsBackend. Website uses the persistent preview Website as its parent. Backend Previews use one shared `jobs-pr-backend` parent. The frontend URL is `https://pr-<number>-jobs-preview.rowland-ekemezie.workers.dev`. GitHub shows it in deployments and in one bot comment updated after each successful deployment, with the deployed commit. Fork PRs run CI without deployment credentials.

PR code uses the persistent preview D1 and queue bindings, never production data. Cloudflare does not automatically isolate D1 data per Preview; shared preview accounts and edits are visible across PRs. Only the persistent preview owns migrations, ingestion, queue consumption and scheduled delivery. Schema changes that cannot coexist with the shared preview schema need a separate data migration plan. PRs cannot enable Checkout, scheduled mail or AI spend; test Stripe Checkout on the persistent preview.

[Service bindings reach the parent's normal deployment](https://developers.cloudflare.com/workers/previews/resources/), so Website forwards to its matching backend Preview over HTTPS. A per-PR credential protects that endpoint before application routing. The backend restores the exact configured PR website origin for auth and reports its PR stage in the smoke test. Preview credentials remain server-side. The shared backend parent serves only a denial response and enables preview routing while its stable public URL stays disabled. Its historical versions contain no application endpoints. This leaves the existing preview backend and its historical versions private. The existing preview environment auth secret supplies both auth and a separately derived transport credential; no extra GitHub secrets are needed.

Closing or merging a PR removes only its two native Previews through Alchemy, retires the deployment link and updates the comment. Cleanup runs trusted base code, shares the PR deployment lock and validates the `pr-N` stage and refuses cleanup unless its state contains only Website, JobsBackend and stack outputs. The persistent preview Workers, shared backend parent, D1, queue and production resources remain owned by their existing stages. Deployment checks the current PR state before writing, so a completed CI run cannot recreate a closed PR's preview.

### Search visibility and public information

The homepage, pricing, job, company, role and information pages render HTML at the edge using the same Foldkit program as the browser. The homepage preloads one bounded page of public listings. It does not forward a visitor's credentials to the backend. Account pages remain private and are never server-rendered or shared in the page cache.

Filtered homepage URLs preserve the selected filters for sharing and browser history, but carry `noindex` and `private, no-store`. The unfiltered homepage and curated job/company/role pages remain the discovery paths. A sitemap fetch does not imply that Google or Bing has indexed its entries. Sitemap dates are omitted because a feed's last successful observation is not a content-change timestamp.

To measure indexing, use an owner-verified [Google Search Console](https://search.google.com/search-console) and [Bing Webmaster Tools](https://www.bing.com/webmasters/) property for the production origin. Submit `/sitemap.xml` and inspect the homepage, one current job, one company and one role URL. Check the rendered content, selected canonical and indexing status. Verify an arbitrary filtered homepage is excluded and preview remains excluded. Property verification requires access to the owner's search accounts; it is separate from deployment smoke tests.

Public `/about`, `/privacy`, `/terms` and `/contact` pages describe coverage, data handling and support. Account deletion is currently a manual support request, with a link from the account page. It is not an automated deletion flow or subscription cancellation. Google for Jobs markup remains subject to source permission and complete, accurate job data; public-page rendering does not relax those requirements.

### Workers plan

Workers Paid ($5 a month) is recommended. Workers Free limits each cron run to 50 subrequests and 10 ms of CPU, which is not enough to parse the default 30 job boards a run. On Free, deploy with `INGEST_FEEDS_PER_RUN=8` in `.env.local` (or the shell) so each run stays inside those limits.

## Change it

- Add a company: append `{ ats, name, slug }` to `packages/job-sources/src/boards.ts`. The slug is the one in the company's public board URL.
- Change what counts as a leadership role: `packages/core/src/role.ts`.
- Change how locations map to regions: `packages/core/src/location.ts`.
- Change ranking weights: `roleWeight`, `regionWeight` and the bonuses in `packages/core/src/posting.ts`.
- Change the refresh cadence: `INGEST_SCHEDULE` in `apps/api/src/worker.ts`.

## Workspace

| Path | What it is |
| --- | --- |
| `packages/core` | Contracts, classifiers, feed scheduling, the store and feed ports, and the ingest run |
| `packages/job-sources` | Feed adapters for each ATS and aggregator |
| `packages/job-store` | The D1 store and its migrations |
| `packages/capability` | rat-stack's contract and projection toolkit |
| `apps/api` | The `JobsBackend` RPC Worker and cron |
| `apps/web` | The Foldkit board and its edge entry |
| `apps/infra` | The Alchemy stack |

## License

MIT
