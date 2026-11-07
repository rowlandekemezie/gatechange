# Use it with your agent

Add the MCP server to Claude Code:

```sh
claude mcp add --transport http gate-change https://gatechange.dev/mcp
```

Any MCP client that speaks streamable HTTP can use the same URL. Without a token, the server exposes three tools: `listJobs`, `getJob` and `boardStats`. It allows 30 calls a minute.

Pro members can create an agent token on their account page and pass it as a header:

```sh
claude mcp add --transport http gate-change https://gatechange.dev/mcp --header "Authorization: Bearer <your-token>"
```

A token raises the limit to 120 calls a minute. It also adds tools to save searches (`saveSearch`, `savedSearches`, `deleteSearch`) and to track applications (`trackJob`, `trackedJobs`, `noteTrackedJob`, `untrackJob`).

## What the tools return

The board lists engineering leadership roles at four levels: engineering manager, director, head of engineering and VP. It has no level for CTOs or other C-level roles.

The `regions` argument of `listJobs` and `saveSearch` selects the same roles as the website:

| You pass | You get |
| --- | --- |
| `RemoteUnitedStates` | `RemoteUnitedStates`, `RemoteNorthAmerica` and `RemoteGlobal` roles |
| `RemoteCanada` | `RemoteCanada`, `RemoteNorthAmerica` and `RemoteGlobal` roles |
| Any other region | That region only |

An empty `regions` list in `listJobs` returns every region. Each job reports its own `region`, so filter on that field to keep only US-specific or Canada-specific roles. `boardStats` counts each role under its exact region, so its `RemoteUnitedStates` count can be lower than the `listJobs` total for that region.

The server returns listings only from sources whose terms do not forbid agent access. Hacker News, Himalayas and Remotive listings appear on the website but not over MCP, so the website can show more roles for the same search.
