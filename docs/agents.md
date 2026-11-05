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

The server returns listings only from sources whose terms do not forbid agent access.
