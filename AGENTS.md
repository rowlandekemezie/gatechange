# Agent instructions

For a non-trivial task, start with `skills/rat-stack-mode`.

This file is the repo law for agents and contributors. It holds commands, validation rules, architecture constraints, and project stop rules. Read `VISION.md` for intent before planning substantial work. `VISION.md` does not override this file. Pi sessions also load `.pi/APPEND_SYSTEM.md` and the repo-local extension `.pi/extensions/project.ts`.

## Stack contract

Workspace `package.json` files declare the pinned stack. [README.md](./README.md#what-is-in-the-stack) summarizes it. Keep dependencies exact. Repo-local config wins. Record drift instead of silently migrating the project.

- pnpm workspaces + Turborepo (`apps/*`, `packages/*`)
- Node `>=24.18.0` and pnpm `11.3.0`; do not replace pnpm with Bun or npm for installs
- Effect `4.0.0` and `@effect/platform-node` `4.0.0`. Hold the runtime family here until Foldkit publishes against a newer Effect; its exact peer and platform dependency must share one runtime.
- XState `6.0.0-alpha.65` for finite lifecycles, retries, cancellation, and resumability
- `@xstate/effect` `0.1.0-alpha.7` bridges the two: machines run as scoped Effects via `createEffectActor`, side effects are declared `fromEffect` actors. This pin was published to npm 2026-10-08; `vendor/README.md` keeps the rules for the next unpublished pin
- Alchemy `2.0.0-beta.83` (Infrastructure as Effects) for every cloud resource; declared in `apps/infra/alchemy.run.ts`, authenticated through Alchemy profiles, never through env vars in this repo
- TypeScript `7.0.2` in strict mode, patched by `@effect/tsgo` `0.51.1` in `prepare` so the Effect language service diagnostics in `tsconfig.base.json` fail `tsc`, not just the editor. Escape hatch for a real boundary: `// @effect-diagnostics-next-line <rule>:off` with a reason. Recorded debt, approved by the operator on 2026-10-16: the five verify scripts `drive.ts`, `local-d1.ts`, `local-only-state.ts`, `record-fixtures.ts` and `seed-local-d1.ts` in `.claude/skills/verify/scripts/` open with a file-level `// @effect-diagnostics <rules>:off -- <reason>`. Retire it by rewriting them as Effect programs; no new file gets a file-level directive
- `@effect/vitest` `4.0.0` for every Effect test: `it.effect` and `it.layer(layer)`; `Effect.run*` and `ManagedRuntime.make` in test files are a lint error
- `@oxlint/plugins` `1.88.0` for the two typed lint rules in `scripts/oxlint-plugin-*.ts` and the vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules in `tools/oxlint/anti-slop/` (all generic rules plus the Effect group, at `error`). The copy is ours; `UPSTREAM.md` there says where it came from and how to take upstream fixes
- Oxlint `1.88.0` with Ultracite `7.12.0`, Oxfmt `0.68.0`, and Turborepo `2.11.2`
- varlock `1.23.0`: declare every env var in `.env.schema`, never read `.env.local` directly, run `pnpm env:check` after schema edits

The base Effect plugin owns diagnostic severity. Child configs may add exact `allowedUnstableApis` only for modules warned about in that scope. Do not use subtree prefixes, copy severity maps, or set `ignoreEffectWarningsInTscExitCode` to true.

## Packages

| Package | Path | Role |
| --- | --- | --- |
| `@rat-stack/capability` | `packages/capability` | `defineContract`, `implement`, and the RPC, HTTP, MCP and CLI projections |
| `@rat-stack/core` | `packages/core` | Job schemas, the `listJobs`, `boardStats` and `getJob` contracts and capabilities, role and placement classifiers, feed scheduling, the `JobStore` port (including `find` for one job by id) and the `PostingFeeds` port, and `runIngest` |
| `@rat-stack/job-sources` | `packages/job-sources` | `PostingFeeds` adapter: Greenhouse, Lever and Ashby company boards, Remote OK, Remotive, Himalayas, Jobicy and the Hacker News hiring thread. `src/boards.ts` is the verified company registry |
| `@rat-stack/job-store` | `packages/job-store` | `JobStore` adapter over a `SqlExecutor` port; `@rat-stack/job-store/d1` binds it to Cloudflare D1 and declares the `JobsDatabase` resource with `migrations/` |
| `@rat-stack/accounts` | `packages/accounts` | better-auth options (magic link, GitHub, Google), the `AccountStore` adapter that turns a session cookie into a `Viewer`, and the magic link email. Auth tables live in `packages/job-store/migrations/0004_accounts.sql` |
| `@rat-stack/digest-mailer` | `packages/digest-mailer` | `DigestMailer` adapter over Cloudflare Email Sending: renders the weekly saved-search digest, signs the no-login unsubscribe token, and flags quota errors. Alert tables live in `packages/job-store/migrations/0006_alerts.sql` |
| `@rat-stack/api` | `apps/api` | `JobsBackend` RPC Worker: serves the capabilities over `/rpc`, runs `runIngest` on a 20 minute cron and `runDigests` hourly, and serves `/unsubscribe` |
| `@rat-stack/web` | `apps/web` | Foldkit board UI and the edge entry `src/worker.ts`, which forwards `/rpc` and `/api/auth/*` to `JobsBackend` and serves assets |
| `@rat-stack/infra` | `apps/infra` | Alchemy Stack: `JobsBackend`, D1, and the `Website` on `jobs.rowlandekemezie.com`. Only the `prod` stage attaches that domain (`src/site-routing.ts`); every other deployed stage serves on its `workers.dev` URL |

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install workspace dependencies |
| `pnpm dev` | `alchemy dev`: run JobsBackend, a local D1 and the Website on your machine |
| `pnpm check` | Typecheck, verify formatting, and run type-aware linting |
| `pnpm lint` | Type-aware lint plus format check only; `turbo run check` runs this once at the root as `//#lint` |
| `pnpm fix` | Apply Oxfmt and safe Oxlint fixes |
| `pnpm test` | Build and run the Vitest suite once |
| `pnpm build` | Compile package outputs |
| `pnpm typecheck` | `turbo run typecheck` |
| `pnpm vendor:agent-sources` | Shallow-clone Effect, effect-solutions, xstate, alchemy, better-auth, and Foldkit mirrors |
| `pnpm infra:plan` | Preview the Alchemy Stack diff without applying |
| `pnpm infra:deploy` / `pnpm infra:destroy` | Apply or tear down the Stack (asks for approval) |
| `pnpm exec lefthook install` | Install git hooks (also via `prepare`) |
| `pnpm turbo run check test build` | Required validation before claiming a change is ready |

Run `pnpm fix` only when you intend to rewrite files. Finish with `pnpm turbo run check test build`.

## Deploy

- CI (`.github/workflows/ci.yml`) runs `pnpm turbo run check test build --concurrency=1` on every pull request and push. A push to `main` that passes deploys the `prod` stage and smoke-tests `https://jobs.rowlandekemezie.com`.
- CI authenticates with the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. `apps/infra/stacks/github.ts` mints that scoped token and writes both secrets; run it with `pnpm infra:ci-credentials --profile admin` to create or rotate them.
- Local deploys use an Alchemy profile: `pnpm alchemy profile edit --add Cloudflare`, then `ALCHEMY_PROFILE=<name> pnpm infra:plan --stage prod` and `pnpm infra:deploy --stage prod`.
- The zone `rowlandekemezie.com` must already be on the Cloudflare account. Alchemy attaches `jobs.rowlandekemezie.com` as a Worker custom domain.
- `DIGEST_SENDS_PER_RUN` and `DIGEST_DAILY_SEND_LIMIT` (apps/api/.env.schema) bound saved-search digests. Email Sending gives new accounts a small daily quota that sign-in links share, so keep the daily limit under it.
- `INGEST_FEEDS_PER_RUN` and `INGEST_FEED_CONCURRENCY` (apps/api/.env.schema) tune the cron. Workers Free allows 50 external subrequests (`fetch`, retries included) and 1,000 to Cloudflare services such as D1 per invocation, and 10 ms CPU; waiting on I/O is not CPU. A board feed costs one fetch, a SmartRecruiters board up to five pages. Each fetch can retry twice on a transient error, and every redirect hop counts as a subrequest. A SmartRecruiters board listing more than `SMARTRECRUITERS_MAX_POSTINGS` (500) postings fails closed: the cap check runs on the first page, before any further page is requested or retried, so an over-cap board costs one fetch plus its own transient retries and never replaces its feed with a partial list.

## Fence (cheating is uncomfortable)

Why lives in `AGENTS.md` / `VISION.md`. The stack and hooks are the enforceable fence. Fence wins over prose.

- Lefthook pre-commit runs `pnpm check` and `pnpm test`
- Agents must not use `git … --no-verify` (or equivalent hook bypass)
- Blocked by: Pi `.pi/extensions/git-interceptor`, Cursor `.cursor/hooks.json`, Claude Code `.claude/settings.json`
- Policy source: `scripts/vcs-command-policy.js`

If a hook fails, fix the failure. Do not disable the fence.

## Source-first Effect / XState work

Before writing, reviewing, or refactoring Effect or XState code, read the installed Effect package's `AGENTS.md` first, for example `packages/core/node_modules/effect/AGENTS.md`. It ships with the installed version, so it is never stale. Then inspect vendored source for the pinned versions. Populate mirrors:

```sh
pnpm vendor:agent-sources
# or
./scripts/vendor-agent-sources.sh --refresh
```

Inventory: `.agent_sources/README.md` is generated in the local source mirror and is not part of this repository.

| Need | Path |
| --- | --- |
| Effect Schema, Context.Service, CLI | `.agent_sources/github.com/Effect-TS/effect/` |
| Idiomatic Effect | `.agent_sources/github.com/kitlangton/effect-solutions/` |
| XState | `.agent_sources/github.com/statelyai/xstate/` |
| `@xstate/effect` (v6 Effect bridge) | `.agent_sources/github.com/statelyai/xstate/packages/xstate-effect/` (`README.md`, `docs/`, `src/*.test.ts`) |
| Alchemy resources, Cloudflare, AWS | `.agent_sources/github.com/alchemy-run/alchemy/` and https://alchemy.run/llms.txt |

Refs are derived from the workspace pins, so bumping a package and re-running the script keeps them matched. The `pi-effect` tool reads the Effect mirror in place; it needs no link.

Mirrors are reference material, not runtime dependencies. Exclude them from typecheck, test, lint, and format. Do not vendor product-specific corpora in this template.

## Source control

Preserve existing work. Inspect status before editing, stage only files changed for the current task, and do not commit generated output, secrets, or populated `.agent_sources/github.com/` trees. Use the repository's existing source-control tool; do not initialize or migrate one without approval. Never pass `--no-verify` to git.

## Project law

- One contract, every surface. `listJobs`, `boardStats` and `getJob` live in `packages/core/src/contracts.ts`; the browser and the Worker share them through `toRpcGroup` and `toRpc`.
- Core owns ports and domain rules. HTTP lives in `packages/job-sources`, SQL in `packages/job-store`.
- The store is the system of record for listings. Each feed owns its rows: a successful fetch upserts what it listed and deletes that feed's rows it did not list. A failed fetch changes nothing and backs the feed off.
- Rows older than 30 days are pruned on every run. Every run writes a receipt to `ingest_runs`.
- Ingest runs never overlap. A run first claims the one-row `ingest_lease` for 15 minutes, the Cron Trigger wall-time limit, and releases it when done; a run that finds it held fails with `IngestInProgress` and writes nothing. `job_history.sightings` counts runs in start order, so it is only correct under this lease.
- `job_history` keeps one row per role fingerprint and survives the 30-day prune, so days open and repost counts outlive the `jobs` row.
- Parse every external payload with Effect Schema at the boundary. One malformed listing is skipped, never the whole feed.
- Respect sources: identify the crawler with `USER_AGENT`, keep the per-source minimum intervals in `feed-spec.ts`, link every listing to its original posting, and credit aggregators in the footer.
- No comments in code (`no-comments/no-comments`). Directives with a reason and `SAFETY:` lines survive.
- Prefer property and model tests. `packages/core/test/ingest.model.test.ts` is the model for feed replacement.

## Architecture

```text
cron (20 min) ─▶ JobsBackend.runIngest ─▶ PostingFeeds ─▶ public job APIs
                         │
                         ▼
                      JobStore ─▶ D1 (jobs, feeds, ingest_runs, job_history)
                         ▲
browser ─▶ Website /rpc ─┴─▶ JobsBackend listJobs / boardStats / getJob
```

- `selectDueFeeds` picks the feeds that are due, oldest attempt first, with exponential backoff after failures.
- `listJobs` deduplicates the same company and title across sources and prefers the company board.
- Relevance is `role weight + region weight + salary and remote bonuses - 2.5 per day of age`.
- The shortlist (Saved, Applied) lives in the viewer's `localStorage` only.
- `JobsBackend` serves better-auth under `/api/auth/*` and resolves each `/rpc` request's session into a `CurrentViewer` (`Anonymous` or `Member`) before the RPC server is built. A request with no session cookie skips the lookup. Member-only capabilities fail with `Unauthorized`.
- better-auth runs with runtime schema validation off (`validateSchema: false` in `packages/accounts/src/options.ts`). If the auth tables drift from the migrations, session lookups fail and the viewer reads as signed out, with only a WARN in the logs. The `auth schema` test in `packages/accounts/test/auth-flow.test.ts` fails on that drift, so add a migration with every better-auth upgrade or option change that adds a column.
- A magic link counts against its address only after better-auth has validated it. The budget key is the address better-auth will mail, lowercased. Only `gmail.com` and `googlemail.com` fold dots and `+tag` onto one inbox, because Gmail delivers every such spelling there. Any other `+tag` address keeps its own budget. Each key gets 3 sends and 6 attempts per 15 minutes. A failed send gives its send back. It gives its attempt back only when the Email Service error code names a provider fault (`PROVIDER_FAILURES` in `packages/accounts/src/email-send-limit.ts`, read from `SendEmailError.cause.code`). A recipient rejection, such as a suppressed address, or an error with no code keeps the attempt. A database failure on an address's first count is a 500, never a 429.
- A job link is kept only when it is an absolute `http(s)` URL that resolves to the same address on its own and against one of our pages, and whose host is not ours: not `rowlandekemezie.com` or a subdomain, `workers.dev`, `localhost`, `0.0.0.0` or a `127.0.0.0/8` or `[::1]` loopback address. `offSiteHref` in `packages/core/src/site.ts` returns the parsed `href` for such a link. Ingest stores that `href`, never the raw input, and skips any other posting with a warning. Every view that links a job or a shortlist mark renders `offSiteHref(url)` as the `href` and renders none when it is empty, so stored rows and old marks are checked again. Link any new job URL the same way. Spellings such as `https:/api/...` parse as host `api` on their own but resolve to our origin on our pages, which is why the check compares both.
- The verify endpoint accepts only `Sec-Fetch-Site: same-origin`, which is what the `/account/confirm` form sends. Browsers that send no fetch metadata (Safari before 16.4, Firefox before 90) cannot finish a magic-link sign-in.
- The edge Worker classifies every path with `edgeRouteOf` before anything else runs. `backend` paths go to `JobsBackend`. `private` paths (`/account/*`) get the static shell and are never server-rendered. Only `public` paths may be rendered or cached. Any `private` response, and any response that sets a cookie, leaves with `cache-control: private, no-store`. `apps/web/test/edge-routing.test.ts` fails if a merge drops one of these rules.

## Web feature blueprint

`apps/web/src/features/<name>/` holds a thin route and view. It reads the Model and sends Messages; components never handle transport, retries, or process startup. `apps/web/src/client/<name>/` owns the Foldkit program: Model, Messages, `update`, and named `Command.define` definitions. Remote state lives in the Model, as Foldkit `AsyncData` or a `foldkit/experimental` `Query`. The capability in `packages/core` is the shared typed edge, imported by both sides. A cartridge owns durable behavior.

One send follows one path: feature → Message → `update` → named Command → `RpcClient` over the contract's `toRpcGroup` → shared capability → server-side Durable Object or database cartridge. The server stays authoritative. The Command returns a result Message, and `update` folds it into the Model.

## Boundaries and sign-off

- Safe by default: adding a company board to `src/boards.ts`, a new feed adapter, tests, docs, and `pnpm infra:deploy` once `pnpm infra:plan` shows only the intended diff.
- Needs owner sign-off: dependency version changes, loosening the lint or diagnostics fence, `pnpm infra:destroy`, and any plan that replaces or deletes the D1 database.
