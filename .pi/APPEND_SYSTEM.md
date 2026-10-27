# Project context

Pi appends this file to its system prompt for sessions in this repo. It describes Gate Change (gatechange.dev), a job board for engineering leaders built on the rat-stack foundation.

- Repo law lives in `AGENTS.md`; product intent in `VISION.md`. Read both before substantial work.
- Validation gate: `pnpm turbo run check test build`. Lefthook runs `pnpm check` and `pnpm test` on commit; CI runs the full gate on a cold cache, and a green push to `main` deploys prod.
- Product rules: no listing is ever gated behind a sign-in or payment, and every source is used within its published terms. Pro sells instant alerts, salary and seniority filters, and company intel. `VISION.md` has the free and Pro split and the sign-off list.
- Domain terms: a **feed** is one source query or company board that `runIngest` fetches on its own interval; a **listing** is one row in the D1 `jobs` table, owned by the feed that listed it; a **capability** (`packages/core`) is one named, schema-typed behavior such as `listJobs` or `boardStats`; a **projection** (`packages/capability`) turns capabilities into RPC, HTTP, MCP, or CLI; the **fence** is the type-aware lint, Effect language-service diagnostics, and hooks that make bypasses fail loudly.
- Running the board: `.claude/skills/verify/` boots `alchemy dev` on a local stage, seeds the local D1 from recorded fixtures, drives the board in a browser, and saves screenshots. Use it to prove any change a person can see.
- Active constraint: `xstate` and `@xstate/effect` are alpha pins (`6.0.0-alpha.65`, `0.1.0-alpha.7`) with matching `minimumReleaseAgeExclude` entries; bump them together, and read `vendor/README.md` before vendoring anything. Alchemy is a beta pin.
- Current focus: the Jobs Pro program, a linear stack of PRs J1 through J13 that the owner lands one at a time.

## Brain procedures

`.brain/` is the agent-connected project brain (PARA: projects, areas, resources, archives).

- Organize by usefulness. Ask where the note will be useful next.
- Keep notes atomic, linked, source-grounded, authored as `.svx`.
- Capture only durable decisions, terms, tradeoffs, gotchas, sources, questions, and review feedback.
- Refine captures into graph edges, backlinks, summaries, and canonical concepts.
- Express knowledge as code, docs, decisions, UI, issues, or plans. Storage is not the goal; output is.
- No PKM ceremony, no append-only logs as truth, no generic static-site sludge.
