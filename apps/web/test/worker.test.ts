// @effect-diagnostics asyncFunction:off -- The module Worker fetch handler, its bindings, and the Cache API are Promise-based.
import { toRpcGroup } from "@rat-stack/capability/rpc-group";
import { jobBoardContracts } from "@rat-stack/core/contracts";
import type { ListedJobValue } from "@rat-stack/core/contracts";
import { Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import indexHtml from "../index.html?raw";
import worker from "../src/worker.js";

const ORIGIN = "https://jobs.example";

const ROLE_PAGE = `${ORIGIN}/roles/director/remote-canada`;

const director: ListedJobValue = {
  arrangement: "Remote",
  company: "Acme",
  daysOpen: 2,
  feed: "greenhouse:acme",
  firstSeenAt: 1_760_000_000_000,
  id: "greenhouse:acme/1",
  lastSeenAt: 1_760_500_000_000,
  location: "Remote, Canada",
  postedAt: 1_760_000_000_000,
  region: "RemoteCanada",
  relevance: 10,
  reposts: 0,
  role: "Director",
  salary: null,
  source: "Greenhouse",
  title: "Director of Engineering",
  url: "https://boards.example/acme/1",
};

const { group } = toRpcGroup(jobBoardContracts);

const backend = HttpRouter.toWebHandler(
  RpcServer.layerHttp({ group, path: "/rpc", protocol: "http" }).pipe(
    Layer.provide([
      group.toLayer({
        boardStats: () => Effect.die("boardStats is not served here"),
        getJob: () => Effect.succeed(Option.none()),
        listJobs: () =>
          Effect.succeed({
            generatedAt: 1_760_500_000_000,
            jobs: [director],
            total: 1,
          }),
      }),
      RpcSerialization.layerJson,
    ])
  ),
  { disableLogger: true }
);

const edge = (shell: string, backendStatus = 200) => {
  const calls = { backend: 0 };
  const pending: Promise<unknown>[] = [];

  const bindings = {
    ASSETS: {
      fetch: async () => await Promise.resolve(new Response(shell)),
    },
    BACKEND: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.backend += 1;

        return backendStatus === 200
          ? await backend.handler(new Request(input, init))
          : new Response("down", { status: backendStatus });
      },
    },
  };

  const lifetime = {
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
  };

  const get = async (url: string) => {
    const response = await worker.fetch(new Request(url), bindings, lifetime);
    const html = await response.text();

    await Promise.all(pending);

    return { html, status: response.status };
  };

  return { calls, get };
};

const stored = new Map<string, Response>();

const pageCache = {
  match: async (key: Request) =>
    await Promise.resolve(stored.get(key.url)?.clone()),
  put: async (key: Request, response: Response) => {
    stored.set(key.url, await Promise.resolve(response));
  },
};

beforeEach(() => {
  vi.stubGlobal("caches", {
    open: async () => await Promise.resolve(pageCache),
  });
});

afterEach(() => {
  stored.clear();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await backend.dispose();
});

describe("rendered page cache", () => {
  it("serves a repeat request from the cache without the backend", async () => {
    const site = edge(indexHtml);

    const first = await site.get(ROLE_PAGE);
    const second = await site.get(ROLE_PAGE);

    expect(first.status).toBe(200);
    expect(first.html).toContain("Director of Engineering");
    expect(second).toEqual(first);
    expect(site.calls.backend).toBe(1);
  });

  it("renders again when a deploy changes the shell", async () => {
    await edge(indexHtml).get(ROLE_PAGE);

    const redeployed = edge(indexHtml.replace("</head>", "<meta />\n</head>"));
    const page = await redeployed.get(ROLE_PAGE);

    expect(page.html).toContain("Director of Engineering");
    expect(redeployed.calls.backend).toBe(1);
  });

  it("caches nothing when the render falls back to the SPA shell", async () => {
    const page = await edge(indexHtml, 503).get(ROLE_PAGE);

    expect(page.html).toBe(indexHtml);
    expect(stored.size).toBe(0);
  });
});
