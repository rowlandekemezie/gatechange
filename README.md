# Engineering leadership jobs

A job board for engineering managers, directors, heads of engineering and VPs of engineering. It collects roles from public company job boards and remote-job aggregators, keeps the last 30 days, and opens on the freshest, most relevant roles that are remote in Canada, remote in the US, or in Vancouver and BC.

Live at `jobs.rowlandekemezie.com` once deployed. Built on [rat-stack](https://ratstack.sh): Effect 4, Alchemy on Cloudflare Workers and D1, and a Foldkit UI.

## How it works

```text
cron (every 20 min) ─▶ JobsBackend.runIngest
                         ├─ picks the feeds that are due (oldest first, backoff on failure)
                         ├─ fetches each feed and keeps only leadership titles
                         ├─ upserts what a feed listed, deletes what it stopped listing
                         └─ prunes roles older than 30 days and records a run receipt

browser ─▶ Website ─▶ /rpc ─▶ JobsBackend.listJobs / boardStats ─▶ D1
```

Sources:

- 116 company boards on Greenhouse, Lever and Ashby (verified list in `packages/job-sources/src/boards.ts`).
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

1. Make sure `rowlandekemezie.com` is a zone on your Cloudflare account.
2. Add a Cloudflare profile for Alchemy: `pnpm alchemy profile edit --add Cloudflare`.
3. Preview and apply:

   ```sh
   export ALCHEMY_PROFILE=<profile name>
   pnpm infra:plan --stage prod
   pnpm infra:deploy --stage prod
   ```

Alchemy creates the D1 database and applies `packages/job-store/migrations/`, deploys `JobsBackend` with its cron trigger, builds the Foldkit site, and attaches `jobs.rowlandekemezie.com`.

The board fills over the first couple of hours: each cron run fetches 20 due feeds, so all 125 feeds are covered after about seven runs.

### Workers plan

Workers Paid ($5 a month) is recommended. Workers Free limits each cron run to 50 subrequests and 10 ms of CPU, which is not enough to parse 20 large job boards. On Free, deploy with `INGEST_FEEDS_PER_RUN=8` in `.env.local` (or the shell) so each run stays inside those limits.

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
