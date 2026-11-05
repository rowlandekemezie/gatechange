# Gate Change

A job board for engineering leaders: engineering managers, directors, heads of engineering and VPs of engineering. It lists roles that are remote in Canada, remote in the US, or based in Vancouver and British Columbia.

Site: <https://gatechange.dev>

![Gate Change: your next move is on the board](apps/web/public/og.png)

## What it does

- Reads 800+ public job boards and keeps only leadership roles.
- Removes a role when its company stops listing it, so you do not chase ghost jobs.
- Links every listing to the original posting.
- Tracks your applications and emails you new matches.
- Connects to your agent over MCP.

The board is free. The free tier has every listing, search and filters, an application tracker, and a weekly email digest for each saved search. Pro costs $5 a week. It adds instant email alerts, salary and seniority filters, company intel, and agent tokens. Pro never hides a listing. Every listing is public.

## Use it with your agent

```sh
claude mcp add --transport http gate-change https://gatechange.dev/mcp
```

No key is needed to start. See [docs/agents.md](docs/agents.md) for limits, tools and Pro tokens.

## Make it your own

Gate Change is MIT licensed and built to be forked. Change the companies, the roles and the regions, and you have a board for any job family.

It runs on your own Cloudflare account, and you do not need a domain. Payments, email and AI enrichment are optional and stay off until you set them up.

```sh
git clone https://github.com/rowlandekemezie/gatechange.git
cd gatechange
pnpm install
pnpm self-host plan --stage self
```

Follow [docs/self-host.md](docs/self-host.md) for the full setup, including [how to rebrand it](docs/self-host.md#make-it-your-own).

## Docs

- [Run your own](docs/self-host.md): deploy, cost, optional features and rebranding.
- [Use it with your agent](docs/agents.md): MCP setup, tools and limits.
- [How it works](docs/how-it-works.md): how listings are chosen, and the sources.
- [Development](docs/development.md): local setup, architecture and common changes.
- [Operations](docs/operations.md): how the production site is run.

## License

MIT. See [LICENSE](LICENSE). Parts of the code come from other MIT-licensed projects, and the fonts are under the SIL Open Font License. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) reproduces their notices, and [PROVENANCE.md](PROVENANCE.md) lists each borrowed file.
