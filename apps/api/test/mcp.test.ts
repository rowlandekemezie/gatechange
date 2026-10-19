import { describe, expect, it } from "@effect/vitest";
import {
  Account,
  agentCapabilities,
  AgentTokenStore,
  AlertStore,
  BillingStore,
  freeAgentCapabilities,
  jobBoardContracts,
  JobStore,
  proAgentCapabilities,
  SavedSearchId,
  secretHashOf,
  TrackerStore,
  UNAUTHORIZED_MESSAGE,
  Viewer,
} from "@rat-stack/core";
import type {
  AccountStore,
  AccountValue,
  JobValue,
  SourceNameValue,
  SubscriptionRecordValue,
} from "@rat-stack/core";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/http";

import {
  mcpAppLayer,
  recoveringSessions,
  serveMcp,
  serveMcpDiscovery,
} from "../src/mcp.js";
import type { McpWebHandler } from "../src/mcp.js";
import { handleRoutes } from "../src/route.js";

const ORIGIN = "https://jobs.example";

const NOW = 1_760_000_000_000;

const PRO_SECRET = "jobs_pat_pro";

const FREE_SECRET = "jobs_pat_free";

const accountOf = (id: string): AccountValue =>
  Schema.decodeSync(Account)({ email: `${id}@example.com`, id, name: id });

const pro = accountOf("user_pro");

const free = accountOf("user_free");

const unserved = (name: string) => () =>
  Effect.die(`${name} is not served here`);

const job = (source: SourceNameValue, id: string): JobValue => ({
  arrangement: "Remote",
  company: `${source} Co`,
  feed: `${source}:all`,
  firstSeenAt: NOW,
  id,
  lastSeenAt: NOW,
  location: "Remote - Canada",
  postedAt: NOW,
  region: "RemoteCanada",
  relevance: 50,
  role: "Director",
  salary: null,
  source,
  title: "Director of Engineering",
  url: `https://jobs.example.org/${id}`,
});

const board = [job("Greenhouse", "g:1"), job("Remotive", "r:1")];

const fixtureOf = (isolates: number) =>
  Effect.gen(function* fixture() {
    const listedSources: (readonly SourceNameValue[])[] = [];
    const savedBy: string[] = [];

    const hashes = new Map<string, AccountValue>([
      [yield* secretHashOf(PRO_SECRET), pro],
      [yield* secretHashOf(FREE_SECRET), free],
    ]);

    const stores = Layer.mergeAll(
      Layer.succeed(
        JobStore,
        JobStore.of({
          claimIngest: unserved("claimIngest"),
          feedStates: Effect.die("feedStates is not served here"),
          find: (id) =>
            Effect.succeed(
              Option.fromNullishOr(board.find((row) => row.id === id))
            ),
          historyOf: unserved("historyOf"),
          list: (_query, _now, sources) => {
            listedSources.push(sources);

            const jobs = board.flatMap((row) =>
              sources.includes(row.source)
                ? [{ ...row, daysOpen: 0, reposts: 0 }]
                : []
            );

            return Effect.succeed({ jobs, total: jobs.length });
          },
          pruneOlderThan: unserved("pruneOlderThan"),
          recordFeedFailure: unserved("recordFeedFailure"),
          recordRun: unserved("recordRun"),
          recordSightings: unserved("recordSightings"),
          releaseIngest: unserved("releaseIngest"),
          replaceFeed: unserved("replaceFeed"),
          stats: unserved("stats"),
        })
      ),
      Layer.succeed(
        AlertStore,
        AlertStore.of({
          claimDigest: unserved("claimDigest"),
          deleteSearch: unserved("deleteSearch"),
          dueRecipients: unserved("dueRecipients"),
          instantAlertsOf: unserved("instantAlertsOf"),
          jobsSeenSince: unserved("jobsSeenSince"),
          markSent: unserved("markSent"),
          releaseDigest: unserved("releaseDigest"),
          saveSearch: (owner, filters, createdAt) => {
            savedBy.push(owner);

            return Effect.succeed(
              Option.some({
                createdAt,
                filters,
                frequency: "Weekly" as const,
                id: SavedSearchId.make("s1"),
                owner,
              })
            );
          },
          searchesOf: unserved("searchesOf"),
          sendsSince: unserved("sendsSince"),
          setInstantAlerts: unserved("setInstantAlerts"),
          unsubscribe: unserved("unsubscribe"),
        })
      ),
      Layer.succeed(
        TrackerStore,
        TrackerStore.of({
          importMissing: unserved("importMissing"),
          list: unserved("list"),
          note: unserved("note"),
          track: unserved("track"),
          untrack: unserved("untrack"),
        })
      ),
      Layer.succeed(
        BillingStore,
        BillingStore.of({
          accountOfCustomer: unserved("accountOfCustomer"),
          applySubscription: unserved("applySubscription"),
          customerOf: unserved("customerOf"),
          linkCustomer: unserved("linkCustomer"),
          subscriptionsOf: (account) =>
            Effect.succeed(
              account === pro.id
                ? [
                    {
                      account,
                      cancelAtPeriodEnd: false,
                      periodEnd: Number.MAX_SAFE_INTEGER,
                      plan: "Monthly",
                      status: "active",
                      subscriptionId: "sub_1",
                      version: { created: 1, eventId: "evt_1", rank: 0 },
                    } satisfies SubscriptionRecordValue,
                  ]
                : []
            ),
        })
      )
    );

    const tokens = Layer.succeed(
      AgentTokenStore,
      AgentTokenStore.of({
        holderOf: (hash) =>
          Effect.succeed(Option.fromNullishOr(hashes.get(hash))),
        issue: unserved("issue"),
        revoke: unserved("revoke"),
        tokensOf: unserved("tokensOf"),
      })
    );

    const servers: McpWebHandler[] = [];

    for (let index = 0; index < isolates; index += 1) {
      servers.push(
        HttpEffect.toWebHandler(
          yield* HttpRouter.toHttpEffect(mcpAppLayer(stores))
        )
      );
    }

    let turn = 0;

    // @effect-diagnostics-next-line asyncFunction:off -- Stands in for the Promise-based web handler of one isolate.
    const roundRobin: McpWebHandler = async (request, context) => {
      const server = servers[turn % servers.length];

      turn += 1;

      return server === undefined
        ? new Response(null, { status: 503 })
        : await server(request, context);
    };

    const sessions = recoveringSessions(roundRobin);

    const accountStore: AccountStore["Service"] = {
      signInOptions: { socialProviders: [] },
      viewerOf: () => Effect.succeed(Viewer.Anonymous()),
    };

    const handle = handleRoutes({
      accountStore,
      auth: Effect.succeed(HttpServerResponse.text("auth")),
      mcp: (request) =>
        serveMcp(sessions)(request).pipe(
          Effect.provide(Layer.mergeAll(tokens, stores))
        ),
      mcpDiscovery: serveMcpDiscovery,
      rpc: () => Effect.succeed(HttpServerResponse.text("rpc")),
      stripeWebhook: () => Effect.succeed(HttpServerResponse.text("stripe")),
      unsubscribe: () => Effect.succeed(HttpServerResponse.text("unsubscribe")),
    });

    const webHandler = HttpEffect.toWebHandler(handle);

    const send = (path: string, init: RequestInit = {}) =>
      Effect.gen(function* sent() {
        const web = yield* Effect.promise(
          // @effect-diagnostics-next-line asyncFunction:off -- The Web handler is Promise-based.
          async () => await webHandler(new Request(`${ORIGIN}${path}`, init))
        );

        const text = yield* Effect.promise(
          // @effect-diagnostics-next-line asyncFunction:off -- Web Response bodies are Promise-based.
          async () => await web.text()
        );

        return { headers: web.headers, status: web.status, text };
      });

    return { listedSources, savedBy, send };
  });

const fixture = fixtureOf(1);

type Send = Effect.Success<typeof fixture>["send"];

const MCP_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

const RpcResult = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.optional(
      Schema.Struct({ code: Schema.Int, message: Schema.String })
    ),
    result: Schema.optional(Schema.Json),
  })
);

const rpcResultOf = (text: string) =>
  Schema.decodeUnknownSync(RpcResult)(
    text
      .split("\n")
      .findLast((line) => line.startsWith("data: "))
      ?.slice("data: ".length) ?? text
  );

const ToolResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ text: Schema.String })),
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
});

const ToolList = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
});

const session = (send: Send, authorization?: string) =>
  Effect.gen(function* openSession() {
    const auth = authorization === undefined ? {} : { authorization };

    const initialized = yield* send("/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
          protocolVersion: "2025-11-25",
        },
      }),
      headers: { ...MCP_HEADERS, ...auth },
      method: "POST",
    });

    const sessionId = initialized.headers.get("mcp-session-id") ?? "";

    const headers = {
      ...MCP_HEADERS,
      ...auth,
      "mcp-protocol-version": "2025-11-25",
      "mcp-session-id": sessionId,
    };

    yield* send("/mcp", {
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      headers,
      method: "POST",
    });

    let id = 1;

    const call = (method: string, params: Schema.JsonObject) =>
      Effect.gen(function* rpcCall() {
        id += 1;

        const response = yield* send("/mcp", {
          body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
          headers,
          method: "POST",
        });

        return {
          message: rpcResultOf(response.text),
          status: response.status,
        };
      });

    const tool = (name: string, args: Schema.JsonObject) =>
      call("tools/call", { arguments: args, name }).pipe(
        Effect.map(({ message }) =>
          Schema.decodeUnknownSync(ToolResult)(message.result)
        )
      );

    return { call, initialized, tool };
  });

const listQuery = {
  limit: 10,
  maxAgeDays: 30,
  offset: 0,
  regions: ["RemoteCanada"],
  roles: ["Director"],
  search: "",
  sort: "Relevance",
};

describe("board over MCP", () => {
  it.effect(
    "lists the board's free contracts plus the Pro tools and nothing else",
    () =>
      Effect.gen(function* toolList() {
        const { send } = yield* fixture;
        const { call } = yield* session(send);
        const { message } = yield* call("tools/list", {});

        const { tools } = yield* Schema.decodeUnknownEffect(ToolList)(
          message.result
        );

        const names = tools.map(({ name }) => name);

        const contractNames: ReadonlySet<string> = new Set(
          jobBoardContracts.map(({ name }) => name)
        );

        expect(names.toSorted()).toStrictEqual(
          [
            "boardStats",
            "deleteSearch",
            "getJob",
            "listJobs",
            "noteTrackedJob",
            "saveSearch",
            "savedSearches",
            "trackJob",
            "trackedJobs",
            "untrackJob",
          ].toSorted()
        );
        expect(names.toSorted()).toStrictEqual(
          agentCapabilities.map(({ contract }) => contract.name).toSorted()
        );
        expect(names.every((name) => contractNames.has(name))).toBe(true);
        expect(
          freeAgentCapabilities.map(({ contract }) => contract.name)
        ).toStrictEqual(["listJobs", "boardStats", "getJob"]);
        expect(proAgentCapabilities).toHaveLength(7);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "searches for free and leaves out sources whose terms forbid agent access",
    () =>
      Effect.gen(function* freeSearch() {
        const { listedSources, send } = yield* fixture;
        const { tool } = yield* session(send);
        const result = yield* tool("listJobs", listQuery);

        expect(result.isError).toBe(false);
        expect(JSON.stringify(result.structuredContent)).toContain("g:1");
        expect(JSON.stringify(result.structuredContent)).not.toContain("r:1");
        expect(listedSources.at(-1)).not.toContain("Remotive");
        expect(listedSources.at(-1)).toContain("Greenhouse");

        const remotive = yield* tool("getJob", { id: "r:1" });

        expect(remotive.isError).toBe(false);
        expect(remotive.content.map(({ text }) => text)).toStrictEqual([
          "null",
        ]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "answers a Pro tool without a token with a typed Unauthorized error",
    () =>
      Effect.gen(function* anonymousPro() {
        const { savedBy, send } = yield* fixture;
        const { tool } = yield* session(send);

        const result = yield* tool("saveSearch", {
          filters: {
            regions: ["RemoteCanada"],
            roles: ["Director"],
            search: "",
          },
        });

        expect(result.isError).toBe(true);
        expect(result.content.map(({ text }) => text).join("")).toBe(
          UNAUTHORIZED_MESSAGE
        );
        expect(savedBy).toStrictEqual([]);
      }).pipe(Effect.scoped)
  );

  it.effect("saves a search for the Pro member who holds the token", () =>
    Effect.gen(function* proSave() {
      const { savedBy, send } = yield* fixture;
      const { tool } = yield* session(send, `Bearer ${PRO_SECRET}`);

      const result = yield* tool("saveSearch", {
        filters: { regions: ["RemoteCanada"], roles: ["Director"], search: "" },
      });

      expect(result.isError).toBe(false);
      expect(savedBy).toStrictEqual(["user_pro"]);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "refuses an unknown or revoked token with 401 and a bearer challenge",
    () =>
      Effect.gen(function* revoked() {
        const { send } = yield* fixture;
        const { initialized } = yield* session(send, "Bearer jobs_pat_revoked");

        expect(initialized.status).toBe(401);
        expect(initialized.headers.get("www-authenticate")).toBe(
          'Bearer error="invalid_token"'
        );
        expect(initialized.text).toContain("unknown or revoked");
      }).pipe(Effect.scoped)
  );

  it.effect("refuses a token whose holder is no longer Pro with 403", () =>
    Effect.gen(function* lapsed() {
      const { send } = yield* fixture;
      const { initialized } = yield* session(send, `Bearer ${FREE_SECRET}`);

      expect(initialized.status).toBe(403);
      expect(initialized.text).toContain("Pro has ended");
    }).pipe(Effect.scoped)
  );

  it.effect("answers malformed tool input with the schema error", () =>
    Effect.gen(function* badInput() {
      const { listedSources, send } = yield* fixture;
      const { tool } = yield* session(send);
      const result = yield* tool("listJobs", { ...listQuery, limit: "ten" });

      expect(result.isError).toBe(true);
      expect(result.content.map(({ text }) => text).join("")).toBe(
        "Invalid parameters for tool 'listJobs': Expected number\n  at [\"limit\"]"
      );
      expect(listedSources).toStrictEqual([]);
    }).pipe(Effect.scoped)
  );

  it.effect("refuses a browser page on another origin", () =>
    Effect.gen(function* crossOrigin() {
      const { send } = yield* fixture;

      const response = yield* send("/mcp", {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
        headers: { ...MCP_HEADERS, origin: "https://evil.example" },
        method: "POST",
      });

      expect(response.status).toBe(403);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "keeps a session working when its calls land on an isolate that never saw it",
    () =>
      Effect.gen(function* acrossIsolates() {
        const { savedBy, send } = yield* fixtureOf(2);
        const { tool } = yield* session(send, `Bearer ${PRO_SECRET}`);
        const results = [];

        for (let index = 0; index < 6; index += 1) {
          results.push(
            yield* tool("saveSearch", {
              filters: {
                regions: ["RemoteCanada"],
                roles: ["Director"],
                search: `run ${index}`,
              },
            })
          );
        }

        expect(results.map(({ isError }) => isError)).toStrictEqual(
          Array.from({ length: 6 }, () => false)
        );
        expect(savedBy).toHaveLength(6);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "describes the endpoint and every tool at /.well-known/mcp.json",
    () =>
      Effect.gen(function* discovery() {
        const { send } = yield* fixture;
        const response = yield* send("/.well-known/mcp.json");

        const document = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              endpoint: Schema.String,
              tools: Schema.Array(
                Schema.Struct({ access: Schema.String, name: Schema.String })
              ),
              transport: Schema.String,
            })
          )
        )(response.text);

        expect(response.status).toBe(200);
        expect(document.endpoint).toBe(`${ORIGIN}/mcp`);
        expect(document.transport).toBe("streamable-http");
        expect(
          document.tools
            .filter(({ access }) => access === "free")
            .map(({ name }) => name)
        ).toStrictEqual(["listJobs", "boardStats", "getJob"]);
        expect(document.tools).toHaveLength(10);
      }).pipe(Effect.scoped)
  );
});
