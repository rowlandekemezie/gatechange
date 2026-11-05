# Development

`pnpm dev` runs `alchemy dev`. It serves the website, `JobsBackend` and a local D1 on `localhost`. `alchemy dev` keeps its stage records in the Alchemy state store on your Cloudflare account, so set up credentials as in [Deploy](#deploy) step 2. `pnpm dev` does not read `.env.local`. Export these in your shell first:

```sh
export ALCHEMY_PROFILE=mine
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export AUTH_EXTRA_HOSTS='localhost:*'
pnpm dev
```

The local board starts empty and fills from live sources on each cron run.

Run the gate before you open a pull request. CI runs the same gate on every pull request:

```sh
pnpm turbo run check test build
```

`pnpm fix` applies the formatter and safe lint fixes. [AGENTS.md](../AGENTS.md) is the contributor law: commands, architecture rules, and what needs the owner's sign-off. [VISION.md](../VISION.md) sets product intent.

## Architecture

```text
cron (every 20 min) ─▶ JobsBackend.runIngest
                         ├─ picks the feeds that are due (oldest first, backoff on failure)
                         ├─ fetches each feed and keeps only leadership titles
                         ├─ upserts what a feed listed, marks what it stopped listing departed
                         └─ prunes departed and expired roles and records a run receipt

browser ─▶ Website ─▶ /rpc ─▶ JobsBackend ─▶ D1
agent   ─▶ Website ─▶ /mcp ─▶ JobsBackend ─▶ D1
```

| Path | What it holds |
| --- | --- |
| `packages/core` | Schemas, contracts, role and region classifiers, ranking, feed scheduling, source terms, and the ingest run |
| `packages/capability` | Turns one contract into RPC, HTTP, MCP and CLI endpoints |
| `packages/job-sources` | Feed adapters for each job board and aggregator, and the company list in `src/boards.ts` |
| `packages/job-store` | The D1 store and its migrations |
| `packages/job-enrichment` | The Workers AI enricher and its queue |
| `packages/accounts` | Sign-in with better-auth, sessions and email send limits |
| `packages/billing` | Stripe Checkout, the billing portal and webhooks |
| `packages/digest-mailer` | Digest and alert emails, and unsubscribe links |
| `apps/api` | The `JobsBackend` Worker: RPC, MCP, cron jobs and the enrichment queue consumer |
| `apps/web` | The Foldkit UI and the website Worker that renders pages at the edge |
| `apps/infra` | The Alchemy stack and `pnpm self-host` |

## What is in the stack

The workspace `package.json` files pin every version. The main parts are [Effect](https://effect.website) 4, [Alchemy](https://alchemy.run) for Cloudflare Workers, D1, Queues and Workers AI, [Foldkit](https://github.com/foldkit/foldkit) for the UI, better-auth, and Stripe. The workspace started from the [rat-stack](https://github.com/joelhooks/rat-stack) template.

## Common changes

- Add a company: append `{ ats, name, slug }` to `packages/job-sources/src/boards.ts`. The slug is the one in the company's public board URL.
- Change which titles count as leadership roles: `packages/core/src/role.ts`.
- Change how locations map to regions: `packages/core/src/location.ts`.
- Change ranking weights: `roleWeight`, `regionWeight` and the bonuses in `packages/core/src/posting.ts`.
