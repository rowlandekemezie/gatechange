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

import { mcpAppLayer, serveMcp } from "../src/mcp.js";
import { handleRoutes } from "../src/route.js";

const ORIGIN = "https://jobs.example";

const NOW = 1_760_000_000_000;

const PROTOCOL = "2026-07-28";

const PRO_SECRET = "jobs_pat_pro";

const OTHER_PRO_SECRET = "jobs_pat_other_pro";

const FREE_SECRET = "jobs_pat_free";

const accountOf = (id: string): AccountValue =>
  Schema.decodeSync(Account)({ email: `${id}@example.com`, id, name: id });

const pro = accountOf("user_pro");

const otherPro = accountOf("user_other_pro");

const free = accountOf("user_free");

const activeSubscription = (
  account: AccountValue["id"]
): SubscriptionRecordValue => ({
  account,
  cancelAtPeriodEnd: false,
  periodEnd: Number.MAX_SAFE_INTEGER,
  plan: "Monthly",
  status: "active",
  subscriptionId: `sub_${account}`,
  version: { created: 1, eventId: "evt_1", rank: 0 },
});

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

const served = (sources: readonly SourceNameValue[]) =>
  board.filter((row) => sources.includes(row.source));

const fixture = Effect.gen(function* fixture() {
  const listedSources: (readonly SourceNameValue[])[] = [];
  const countedSources: (readonly SourceNameValue[])[] = [];
  const savedBy: string[] = [];

  const hashes = new Map<string, AccountValue>([
    [yield* secretHashOf(PRO_SECRET), pro],
    [yield* secretHashOf(OTHER_PRO_SECRET), otherPro],
    [yield* secretHashOf(FREE_SECRET), free],
  ]);

  const stores = Layer.mergeAll(
    Layer.succeed(
      JobStore,
      JobStore.of({
        claimIngest: unserved("claimIngest"),
        claimNeurons: unserved("claimNeurons"),
        feedStates: Effect.die("feedStates is not served here"),
        find: (id) =>
          Effect.succeed(
            Option.fromNullishOr(board.find((row) => row.id === id)).pipe(
              Option.map((row) => ({ ...row, enrichment: null }))
            )
          ),
        historyOf: unserved("historyOf"),
        list: (_query, _now, sources) => {
          listedSources.push(sources);

          const jobs = served(sources).map((row) => ({
            ...row,
            daysOpen: 0,
            enrichment: null,
            reposts: 0,
          }));

          return Effect.succeed({ jobs, total: jobs.length });
        },
        neuronsClaimed: unserved("neuronsClaimed"),
        pruneOlderThan: unserved("pruneOlderThan"),
        recordFeedFailure: unserved("recordFeedFailure"),
        recordNeuronsUsed: unserved("recordNeuronsUsed"),
        recordRun: unserved("recordRun"),
        recordSightings: unserved("recordSightings"),
        recordSkip: unserved("recordSkip"),
        releaseIngest: unserved("releaseIngest"),
        replaceFeed: unserved("replaceFeed"),
        saveEnrichment: unserved("saveEnrichment"),
        stats: (_now, sources) => {
          countedSources.push(sources);

          return Effect.succeed({
            activeJobs: served(sources).length,
            feedsFailing: 0,
            feedsTotal: 2,
            lastRun: null,
            newToday: 0,
            regions: [],
            roles: [],
          });
        },
        unenrichedListings: unserved("unenrichedListings"),
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
            account === pro.id || account === otherPro.id
              ? [activeSubscription(account)]
              : []
          ),
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

  const mcpHttp = yield* HttpRouter.toHttpEffect(mcpAppLayer(stores));

  const accountStore: AccountStore["Service"] = {
    signInOptions: { socialProviders: [] },
    viewerOf: () => Effect.succeed(Viewer.Anonymous()),
  };

  const webHandler = HttpEffect.toWebHandler(
    handleRoutes({
      accountStore,
      auth: Effect.succeed(HttpServerResponse.text("auth")),
      mcp: (request) =>
        serveMcp(mcpHttp)(request).pipe(
          Effect.provide(Layer.mergeAll(tokens, stores))
        ),
      rpc: () => Effect.succeed(HttpServerResponse.text("rpc")),
      stripeWebhook: () => Effect.succeed(HttpServerResponse.text("stripe")),
      unsubscribe: () => Effect.succeed(HttpServerResponse.text("unsubscribe")),
    })
  );

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

  return { countedSources, listedSources, savedBy, send };
});

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

const requestMeta = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/protocolVersion": PROTOCOL,
};

const client = (send: Send, authorization?: string) => {
  let id = 0;

  const call = (
    method: string,
    params: Readonly<Record<string, Schema.Json>>,
    name?: string
  ) =>
    Effect.gen(function* rpcCall() {
      id += 1;

      const headers = new Headers({
        ...MCP_HEADERS,
        "mcp-method": method,
        "mcp-protocol-version": PROTOCOL,
      });

      if (authorization !== undefined) {
        headers.set("authorization", authorization);
      }

      if (name !== undefined) {
        headers.set("mcp-name", name);
      }

      const response = yield* send("/mcp", {
        body: JSON.stringify({
          id,
          jsonrpc: "2.0",
          method,
          params: { _meta: requestMeta, ...params },
        }),
        headers,
        method: "POST",
      });

      return {
        headers: response.headers,
        message: rpcResultOf(response.text),
        status: response.status,
      };
    });

  const tool = (name: string, args: Schema.JsonObject) =>
    call("tools/call", { arguments: args, name }, name).pipe(
      Effect.map(({ message }) =>
        Schema.decodeUnknownSync(ToolResult)(message.result)
      )
    );

  return { call, tool };
};

const listQuery = {
  limit: 10,
  maxAgeDays: 30,
  offset: 0,
  regions: ["RemoteCanada"],
  roles: ["Director"],
  search: "",
  sort: "Relevance",
};

const textOf = (result: typeof ToolResult.Type) =>
  result.content.map(({ text }) => text).join("");

describe("board over MCP", () => {
  it.effect(
    "lists the board's free contracts plus the Pro tools and nothing else",
    () =>
      Effect.gen(function* toolList() {
        const { send } = yield* fixture;
        const { message } = yield* client(send).call("tools/list", {});

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
        expect(proAgentCapabilities).toHaveLength(7);
        expect(names.every((name) => contractNames.has(name))).toBe(true);
        expect(
          freeAgentCapabilities.map(({ contract }) => contract.name)
        ).toStrictEqual(["listJobs", "boardStats", "getJob"]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "searches for free and leaves out sources whose terms forbid agent access",
    () =>
      Effect.gen(function* freeSearch() {
        const { listedSources, send } = yield* fixture;
        const { tool } = client(send);
        const result = yield* tool("listJobs", listQuery);

        expect(result.isError).toBe(false);
        expect(JSON.stringify(result.structuredContent)).toContain("g:1");
        expect(JSON.stringify(result.structuredContent)).not.toContain("r:1");
        expect(listedSources.at(-1)).not.toContain("Remotive");
        expect(listedSources.at(-1)).toContain("Greenhouse");

        const remotive = yield* tool("getJob", { id: "r:1" });

        expect(remotive.isError).toBe(false);
        expect(textOf(remotive)).toBe("null");
      }).pipe(Effect.scoped)
  );

  it.effect(
    "counts only the sources agents may see, so boardStats agrees with listJobs",
    () =>
      Effect.gen(function* stats() {
        const { countedSources, send } = yield* fixture;
        const { tool } = client(send);
        const counted = yield* tool("boardStats", {});

        const listed = yield* tool("listJobs", {
          ...listQuery,
          regions: [],
          roles: [],
        });

        expect(countedSources.at(-1)).not.toContain("Remotive");
        expect(JSON.stringify(counted.structuredContent)).toContain(
          '"activeJobs":1'
        );
        expect(JSON.stringify(listed.structuredContent)).toContain('"total":1');
      }).pipe(Effect.scoped)
  );

  it.effect("answers malformed tool input with the schema error", () =>
    Effect.gen(function* badInput() {
      const { listedSources, send } = yield* fixture;

      const result = yield* client(send).tool("listJobs", {
        ...listQuery,
        limit: "ten",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        "Invalid parameters for tool 'listJobs': Expected number\n  at [\"limit\"]"
      );
      expect(listedSources).toStrictEqual([]);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "holds agents to the board's page size of 100 and its 80-character search",
    () =>
      Effect.gen(function* bounds() {
        const { listedSources, send } = yield* fixture;
        const { tool } = client(send);

        const largest = yield* tool("listJobs", { ...listQuery, limit: 100 });

        const tooLarge = yield* tool("listJobs", {
          ...listQuery,
          limit: 101,
        });

        const longest = yield* tool("listJobs", {
          ...listQuery,
          search: "a".repeat(80),
        });

        const tooLong = yield* tool("listJobs", {
          ...listQuery,
          search: "a".repeat(81),
        });

        expect(largest.isError).toBe(false);
        expect(longest.isError).toBe(false);
        expect(tooLarge.isError).toBe(true);
        expect(textOf(tooLarge)).toContain('at ["limit"]');
        expect(tooLong.isError).toBe(true);
        expect(textOf(tooLong)).toContain('at ["search"]');
        expect(listedSources).toHaveLength(2);
      }).pipe(Effect.scoped)
  );

  it.effect("answers GET on the endpoint with 405, not a server error", () =>
    Effect.gen(function* get() {
      const { send } = yield* fixture;

      const response = yield* send("/mcp", {
        headers: { accept: "text/event-stream" },
      });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }).pipe(Effect.scoped)
  );

  it.effect(
    "keeps no sessions: it never hands out a session id, even to a legacy initialize",
    () =>
      Effect.gen(function* stateless() {
        const { send } = yield* fixture;

        const legacy = yield* send("/mcp", {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              capabilities: {},
              clientInfo: { name: "legacy", version: "0" },
              protocolVersion: "2025-11-25",
            },
          }),
          headers: MCP_HEADERS,
          method: "POST",
        });

        const modern = yield* client(send).call("tools/list", {});

        expect(legacy.headers.get("mcp-session-id")).toBeNull();
        expect(modern.headers.get("mcp-session-id")).toBeNull();
        expect(modern.status).toBe(200);
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
    "answers a Pro tool without a token with a typed Unauthorized error",
    () =>
      Effect.gen(function* anonymousPro() {
        const { savedBy, send } = yield* fixture;

        const result = yield* client(send).tool("saveSearch", {
          filters: {
            regions: ["RemoteCanada"],
            roles: ["Director"],
            search: "",
          },
        });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe(UNAUTHORIZED_MESSAGE);
        expect(savedBy).toStrictEqual([]);
      }).pipe(Effect.scoped)
  );

  it.effect("saves a search for the Pro member who holds the token", () =>
    Effect.gen(function* proSave() {
      const { savedBy, send } = yield* fixture;

      const result = yield* client(send, `Bearer ${PRO_SECRET}`).tool(
        "saveSearch",
        {
          filters: {
            regions: ["RemoteCanada"],
            roles: ["Director"],
            search: "",
          },
        }
      );

      expect(result.isError).toBe(false);
      expect(savedBy).toStrictEqual(["user_pro"]);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "takes the viewer from each request's token, never from an earlier request or a session id",
    () =>
      Effect.gen(function* perRequestViewer() {
        const { savedBy, send } = yield* fixture;
        const asPro = client(send, `Bearer ${PRO_SECRET}`);
        const asOther = client(send, `Bearer ${OTHER_PRO_SECRET}`);
        const anonymous = client(send);

        yield* asPro.tool("saveSearch", {
          filters: {
            regions: ["RemoteCanada"],
            roles: ["Director"],
            search: "",
          },
        });
        yield* asOther.tool("saveSearch", {
          filters: {
            regions: ["RemoteCanada"],
            roles: ["Director"],
            search: "",
          },
        });

        const afterPro = yield* anonymous.tool("saveSearch", {
          filters: {
            regions: ["RemoteCanada"],
            roles: ["Director"],
            search: "",
          },
        });

        const replayed = yield* send("/mcp", {
          body: JSON.stringify({
            id: 9,
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              capabilities: {},
              clientInfo: { name: "x", version: "0" },
              protocolVersion: "2025-11-25",
            },
          }),
          headers: { ...MCP_HEADERS, authorization: `Bearer ${PRO_SECRET}` },
          method: "POST",
        });

        const withForeignSession = yield* send("/mcp", {
          body: JSON.stringify({
            id: 10,
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              _meta: requestMeta,
              arguments: {
                filters: {
                  regions: ["RemoteCanada"],
                  roles: ["Director"],
                  search: "",
                },
              },
              name: "saveSearch",
            },
          }),
          headers: {
            ...MCP_HEADERS,
            "mcp-method": "tools/call",
            "mcp-name": "saveSearch",
            "mcp-protocol-version": PROTOCOL,
            "mcp-session-id":
              replayed.headers.get("mcp-session-id") ??
              "a-session-from-user-pro",
          },
          method: "POST",
        });

        expect(savedBy).toStrictEqual(["user_pro", "user_other_pro"]);
        expect(afterPro.isError).toBe(true);
        expect(textOf(afterPro)).toBe(UNAUTHORIZED_MESSAGE);
        expect(replayed.headers.get("mcp-session-id")).toBeNull();
        expect(withForeignSession.text).toContain("Unauthorized:");
      }).pipe(Effect.scoped)
  );

  it.effect(
    "refuses an unknown or revoked token with 401 and a bearer challenge",
    () =>
      Effect.gen(function* revoked() {
        const { send } = yield* fixture;

        const refused = yield* client(send, "Bearer jobs_pat_revoked").call(
          "tools/list",
          {}
        );

        expect(refused.status).toBe(401);
        expect(refused.headers.get("www-authenticate")).toBe(
          'Bearer error="invalid_token"'
        );
        expect(refused.message.error?.message).toContain("unknown or revoked");
      }).pipe(Effect.scoped)
  );

  it.effect("refuses a token whose holder is no longer Pro with 403", () =>
    Effect.gen(function* lapsed() {
      const { send } = yield* fixture;

      const refused = yield* client(send, `Bearer ${FREE_SECRET}`).call(
        "tools/list",
        {}
      );

      expect(refused.status).toBe(403);
      expect(refused.message.error?.message).toContain("Pro has ended");
    }).pipe(Effect.scoped)
  );
});
