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

Only the exact `preview` stage changes these defaults; explicit environment configuration still overrides them:

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

CI deploys both stages after a successful check on a push to `main`. A manual CI run on `main` deploys preview only. Preview gets its own deployment concurrency group. It validates both preview secrets before profile creation, stores the Stripe test key through `alchemy profile edit --add Stripe --method stored --set apiKey=- --no-input` using stdin, plans, deploys, and checks the homepage, auth health, and crawler exclusions. The profile lives in a private ephemeral `ALCHEMY_HOME` removed on success or failure. Only Alchemy profile/plan/deploy subprocesses use `CI=false`, because the pinned CLI otherwise ignores profiles; checks, tests, and builds retain CI behavior. No `STRIPE_API_KEY` environment fallback is used.

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
