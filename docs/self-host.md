# Run your own

You can run your own copy of the board on your own Cloudflare account. It runs on your `workers.dev` subdomain, so you do not need a domain. `pnpm self-host` checks your inputs, then runs [Alchemy](https://alchemy.run) against a stage that you name. Alchemy creates the D1 database, applies the migrations in `packages/job-store/migrations/`, creates the enrichment queue, and deploys both Workers with their cron triggers.

## Prerequisites

- A Cloudflare account. Workers Paid ($5 a month) is recommended. Workers Free works with one extra setting, described in [Cost](#cost).
- Node 24.18 or later.
- pnpm 11.3. Run `corepack enable` to use the version pinned in `package.json`.

## Deploy

> **Warning.** `pnpm self-host` deploys to the Cloudflare account that your credentials resolve to. `CLOUDFLARE_ACCOUNT_ID` with `CLOUDFLARE_API_TOKEN` (or `CLOUDFLARE_API_KEY`) wins over `ALCHEMY_PROFILE`. A value in your shell wins over `.env.local`. Before each run, the command prints the credential source and the account id it will use. Check that account first.

1. Clone the repository and install dependencies:

   ```sh
   git clone https://github.com/rowlandekemezie/gatechange.git
   cd gatechange
   pnpm install
   ```

2. Give Alchemy your Cloudflare credentials. Either create a profile and set `ALCHEMY_PROFILE=mine`:

   ```sh
   pnpm alchemy profile create mine
   pnpm alchemy profile edit --profile mine --add Cloudflare
   ```

   Or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Alchemy's `default` profile is never used.

3. In the Cloudflare dashboard, open **Workers & Pages** and note your account's `workers.dev` subdomain.
4. Copy `.env.example` to `.env.local` and set these values:
   - `ALCHEMY_PROFILE`, if you created a profile.
   - `WORKERS_SUBDOMAIN`, the subdomain from step 3. The build uses it as the site's own host, so the site trusts its own sign-in host and never links a listing back to itself.
   - `BETTER_AUTH_SECRET`, at least 32 characters. Generate one with `openssl rand -hex 32`.
   - `INGEST_FEEDS_PER_RUN=8`, only on Workers Free.

5. Preview the plan, then deploy:

   ```sh
   pnpm self-host plan --stage self
   pnpm self-host deploy --stage self
   ```

The site is at `https://jobs-self.<subdomain>.workers.dev`. It fills over the first few cron runs, which run every 20 minutes.

## Commands

`pnpm self-host [plan|deploy|destroy] --stage <name> [--yes]`

| Command | What it does |
| --- | --- |
| `pnpm self-host plan --stage <name>` | Prints the changes Alchemy would make. Changes nothing. |
| `pnpm self-host deploy --stage <name>` | Creates or updates every resource of the stage. |
| `pnpm self-host destroy --stage <name>` | Removes every resource the stage created. |

- The action defaults to `plan` and the stage defaults to `self`.
- The command reads `.env.local` through [varlock](https://varlock.dev). It checks every input before it builds anything, and stops with a list of what is missing.
- A stage name is lowercase letters, digits and hyphens, starts with a letter, and has at most 40 characters.
- The command refuses the stage names `prod`, `preview` and `pr-<n>`. This repository uses them for its own deployments.
- `deploy` and `destroy` ask you to type `y`. Without a terminal to answer, they refuse unless you pass `--yes`. Pass `--yes` only after a `plan` run has shown you the account.

## Cost

Workers Paid ($5 a month) is recommended. Workers Free allows 50 subrequests per cron run, so set `INGEST_FEEDS_PER_RUN=8` there. D1, the queue and the cron triggers are on both plans. On Workers Free, Workers AI stops at 10,000 neurons a day. If you turn on enrichment there, also set `ENRICHMENT_DAILY_NEURONS=10000`.

## Optional features

Each feature is off while its variables are empty. `.env.example` describes every variable.

- **AI enrichment.** Workers AI reads each company-board listing for salary, seniority and other details. Your stage makes no Workers AI calls until you set `ENRICHMENT_SWEEP_LIMIT`, for example to 8. `ENRICHMENT_DAILY_NEURONS` caps daily spend. The default cap of 29000 keeps a month under about $10.
- **GitHub or Google sign-in.** Set both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, or both Google variables. If a pair is empty, the site hides that button.
- **Email sign-in links and digests.** See [Set up email](#set-up-email). Without it, the board works, but sign-in links and digests fail to send.
- **Paid plans.** Set `BILLING_ENABLED=true` and `PRO_PLANS`, then add a Stripe test key to your Alchemy profile with `pnpm alchemy profile edit --profile mine --add Stripe`.
- **Search engines.** Every stage except `prod` sends `noindex`. To be indexed, point `SITE_HOSTNAME` in `packages/core/src/site.ts` at a hostname in a zone on your account. List only hostnames in your zones in `SITE_REDIRECT_HOSTNAMES`, or leave it empty. Then deploy the `prod` stage, as [operations.md](operations.md#deploy-production-from-your-machine) describes.

## Make it your own

A fresh copy still carries this deployment's name and links. Change these before you share your site.

| What to change | Where |
| --- | --- |
| Site name, hostname and source link: `SITE_NAME`, `SITE_HOSTNAME`, `SOURCE_REPOSITORY_URL` | `packages/core/src/site.ts` |
| Hosts that redirect to your site: `SITE_REDIRECT_HOSTNAMES`. List only hosts in your zones, or leave it empty | `packages/core/src/site.ts` |
| Who runs the board: the about, contact, privacy and terms pages, and the contact link | `apps/web/src/features/information/view.ts` |
| Footer credit | `apps/web/src/client/board/view.ts` |
| Crawler name and contact: `USER_AGENT` | `packages/job-sources/src/http.ts` |
| Companies to read | `packages/job-sources/src/boards.ts` |
| Roles that count | `packages/core/src/role.ts` |
| Regions and locations | `packages/core/src/location.ts` |
| Ranking | `packages/core/src/posting.ts` |
| Logo and social image | `apps/web/public/` |
| Pricing, if you sell plans | `PRO_PLANS` in `.env.local` |

Run `pnpm turbo run check test build` after you change these. Some tests name this deployment's hostnames, so update them to match.

## Set up email

Email is optional. Skip this section if GitHub or Google sign-in is enough for you.

1. In the Cloudflare dashboard, open Email Service and onboard a domain or subdomain in a zone on your account for Email Sending. Cloudflare adds the DNS records.
2. Set `MAIL_HOSTNAME` in `packages/core/src/site.ts` to that exact name. Mail is sent from the `sign-in` and `digest` addresses on it.
3. Deploy, then send yourself a sign-in link to check it.

A sender on a name that is not onboarded fails with `E_SENDER_DOMAIN_NOT_AVAILABLE`.

## Why there is no deploy button

A "Deploy to Cloudflare" button cannot deploy this app. The button deploys one Worker from a directory that builds with no workspace dependencies. This app is two Workers joined by a service binding, and both depend on workspace packages.
