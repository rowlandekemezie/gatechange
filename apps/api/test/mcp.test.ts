import { describe, expect, it } from "@effect/vitest";
import {
  BillingStore,
  freeAgentCapabilities,
  jobBoardContracts,
  JobStore,
  Viewer,
} from "@rat-stack/core";
import type { AccountStore, JobValue, SourceNameValue } from "@rat-stack/core";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/http";

import { mcpAppLayer, serveMcp } from "../src/mcp.js";
import { handleRoutes } from "../src/route.js";

const ORIGIN = "https://jobs.example";

const NOW = 1_760_000_000_000;

const PROTOCOL = "2026-07-28";

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

  const stores = Layer.mergeAll(
    Layer.succeed(
      JobStore,
      JobStore.of({
        claimIngest: unserved("claimIngest"),
        claimNeurons: unserved("claimNeurons"),
        companyRecords: unserved("companyRecords"),
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
        subscriptionsOf: unserved("subscriptionsOf"),
      })
    )
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
      mcp: serveMcp(mcpHttp),
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

  return { countedSources, listedSources, send };
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
  Schema.decodeSync(RpcResult)(
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

const legacyRequest = (
  method: string,
  params: Schema.JsonObject = {},
  version: string | null = "2025-11-25",
  id: number | undefined = method.startsWith("notifications/") ? undefined : 1,
  extraHeaders: Readonly<Record<string, string>> = {}
) =>
  Effect.gen(function* isolatedRequest() {
    const { listedSources, send } = yield* fixture;
    const headers = new Headers({ ...MCP_HEADERS, ...extraHeaders });

    if (version !== null) {
      headers.set("mcp-protocol-version", version);
    }

    const response = yield* send("/mcp", {
      body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
      headers,
      method: "POST",
    });

    return { ...response, listedSources };
  }).pipe(Effect.scoped);

describe("board over MCP", () => {
  for (const version of ["2025-11-25", "2025-06-18"]) {
    it.effect(
      `serves the ${version} lifecycle across fresh runtimes without sessions`,
      () =>
        Effect.gen(function* legacyLifecycle() {
          const initialize = yield* legacyRequest(
            "initialize",
            {
              capabilities: { sampling: {} },
              clientInfo: { name: "ordinary-client", version: "1" },
              protocolVersion: version,
            },
            null
          );

          expect(initialize.status).toBe(200);
          expect(rpcResultOf(initialize.text).result).toMatchObject({
            capabilities: { tools: {} },
            protocolVersion: version,
          });
          expect(initialize.headers.get("mcp-session-id")).toBeNull();

          const initialized = yield* legacyRequest(
            "notifications/initialized",
            {},
            version
          );

          expect(initialized).toMatchObject({ status: 202 });
          expect(initialized.text).toBe("");

          const ping = yield* legacyRequest("ping", {}, version);

          expect(ping.status).toBe(200);
          expect(rpcResultOf(ping.text).result).toStrictEqual({});

          const listed = yield* legacyRequest("tools/list", {}, version);

          const tools = yield* Schema.decodeUnknownEffect(ToolList)(
            rpcResultOf(listed.text).result
          );

          expect(listed.status).toBe(200);
          expect(tools.tools.map(({ name }) => name).toSorted()).toStrictEqual([
            "boardStats",
            "getJob",
            "listJobs",
          ]);

          const called = yield* legacyRequest(
            "tools/call",
            { arguments: listQuery, name: "listJobs" },
            version
          );

          const result = yield* Schema.decodeUnknownEffect(ToolResult)(
            rpcResultOf(called.text).result
          );

          expect(called.status).toBe(200);
          expect(result.isError).toBe(false);
          expect(JSON.stringify(result.structuredContent)).toContain("g:1");
          expect(JSON.stringify(result.structuredContent)).not.toContain("r:1");
          expect(called.listedSources.at(-1)).not.toContain("Remotive");
          expect(called.headers.get("mcp-session-id")).toBeNull();

          const forbidden = yield* legacyRequest(
            "tools/call",
            { arguments: { id: "r:1" }, name: "getJob" },
            version
          );

          expect(
            textOf(
              yield* Schema.decodeUnknownEffect(ToolResult)(
                rpcResultOf(forbidden.text).result
              )
            )
          ).toBe("null");

          const malformed = yield* legacyRequest(
            "tools/call",
            { arguments: { ...listQuery, limit: "ten" }, name: "listJobs" },
            version
          );

          expect(
            (yield* Schema.decodeUnknownEffect(ToolResult)(
              rpcResultOf(malformed.text).result
            )).isError
          ).toBe(true);
          expect(malformed.listedSources).toStrictEqual([]);
        })
    );
  }

  it.effect(
    "rejects legacy protocol and routing contradictions before calling a capability",
    () =>
      Effect.gen(function* contradictoryRequests() {
        for (const [version, headers, params] of [
          ["2099-01-01", {}, {}],
          ["2025-03-26", {}, {}],
          ["2025-11-25", { "mcp-method": "tools/call" }, {}],
          ["2025-11-25", { "mcp-name": "listJobs" }, {}],
          ["2025-11-25", { "mcp-session-id": "invented-session" }, {}],
          ["2025-11-25", {}, { _meta: null }],
          [
            "2025-11-25",
            {},
            {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2025-06-18",
              },
            },
          ],
        ] satisfies readonly (readonly [
          string,
          Readonly<Record<string, string>>,
          Schema.JsonObject,
        ])[]) {
          const response = yield* legacyRequest(
            "tools/list",
            params,
            version,
            1,
            headers
          );

          expect(response.status).toBe(400);
          expect(rpcResultOf(response.text).error).toBeDefined();
          expect(response.listedSources).toStrictEqual([]);
        }

        const noVersion = yield* legacyRequest("tools/list", {}, null);

        expect(noVersion.status).toBe(400);
        expect(noVersion.listedSources).toStrictEqual([]);

        const mismatch = yield* legacyRequest(
          "tools/call",
          { arguments: listQuery, name: "listJobs" },
          "2025-11-25",
          1,
          { "mcp-name": "boardStats" }
        );

        expect(mismatch.status).toBe(400);
        expect(mismatch.listedSources).toStrictEqual([]);

        const invalidName = yield* legacyRequest("tools/call", {
          arguments: {},
          name: "\uD800",
        });

        expect(invalidName.status).toBe(400);
        expect(rpcResultOf(invalidName.text).error?.message).toBe(
          "Invalid tool name"
        );

        const initialize = yield* legacyRequest("initialize", {
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
          protocolVersion: "2025-06-18",
        });

        expect(initialize.status).toBe(400);
      })
  );

  it.effect(
    "rejects malformed legacy envelopes and unsupported transport content",
    () =>
      Effect.gen(function* invalidLegacy() {
        const { send } = yield* fixture;

        for (const body of [
          "{",
          "[]",
          "null",
          '{"jsonrpc":"2.0","id":null,"method":"tools/list"}',
          '{"jsonrpc":"2.0","id":1.5,"method":"ping"}',
          '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":[]}',
        ]) {
          const response = yield* send("/mcp", {
            body,
            headers: { ...MCP_HEADERS, "mcp-protocol-version": "2025-11-25" },
            method: "POST",
          });

          expect(response.status).toBe(400);
          expect(rpcResultOf(response.text).error).toBeDefined();
        }

        for (const [headers, expected] of [
          [{ "content-type": "text/plain" }, 415],
          [{ accept: "application/json" }, 406],
          [{ accept: "application/json, text/event-stream;q=0" }, 406],
          [{ origin: "https://evil.example" }, 403],
        ] satisfies readonly (readonly [
          Readonly<Record<string, string>>,
          number,
        ])[]) {
          const response = yield* legacyRequest(
            "tools/list",
            {},
            "2025-11-25",
            1,
            headers
          );

          expect(response.status).toBe(expected);
        }
      }).pipe(Effect.scoped)
  );

  it.effect(
    "accepts an ordinary Streamable HTTP initialization without a version header",
    () =>
      Effect.gen(function* initialize() {
        const { send } = yield* fixture;

        const response = yield* send("/mcp", {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              capabilities: {},
              clientInfo: { name: "codex", version: "0.163" },
              protocolVersion: "2025-11-25",
            },
          }),
          headers: MCP_HEADERS,
          method: "POST",
        });

        expect(response.status).toBe(200);
        expect(rpcResultOf(response.text).result).toMatchObject({
          capabilities: { tools: {} },
          protocolVersion: "2025-11-25",
        });
        expect(response.headers.get("mcp-session-id")).toBeNull();
      }).pipe(Effect.scoped)
  );

  it.effect(
    "lists the board's read-only contracts as tools and nothing else",
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

        expect(names.toSorted()).toStrictEqual([
          "boardStats",
          "getJob",
          "listJobs",
        ]);
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
});
