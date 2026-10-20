// @effect-diagnostics asyncFunction:off -- The module Worker fetch handler, its bindings, and the Cache API are Promise-based.
import { toRpcGroup } from "@rat-stack/capability/rpc-group";
import { jobBoardContracts } from "@rat-stack/core/contracts";
import type { ListedJobValue } from "@rat-stack/core/contracts";
import { Effect, Layer } from "effect";
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
import { jobRouter } from "../src/client/route.js";
import worker from "../src/worker.js";

const ORIGIN = "https://jobs.example";

const ROLE_PAGE = `${ORIGIN}/roles/director/remote-canada`;

const director: ListedJobValue = {
  arrangement: "Remote",
  company: "Acme",
  daysOpen: 2,
  enrichment: null,
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

const unlimited = {
  limit: async () => await Promise.resolve({ success: true }),
};

const backend = HttpRouter.toWebHandler(
  RpcServer.layerHttp({ group, path: "/rpc", protocol: "http" }).pipe(
    Layer.provide([
      group.toLayer({
        account: () => Effect.die("account is not served here"),
        agentTokens: () => Effect.die("agent tokens are not served here"),
        boardStats: () => Effect.die("boardStats is not served here"),
        deleteSearch: () => Effect.die("deleteSearch is not served here"),
        getJob: () => Effect.succeedNone,
        importShortlist: () => Effect.die("the tracker is not served here"),
        issueAgentToken: () => Effect.die("agent tokens are not served here"),
        listJobs: () =>
          Effect.succeed({
            generatedAt: 1_760_500_000_000,
            jobs: [director],
            total: 1,
          }),
        membership: () => Effect.die("billing is not served here"),
        noteTrackedJob: () => Effect.die("the tracker is not served here"),
        openBillingPortal: () => Effect.die("billing is not served here"),
        revokeAgentToken: () => Effect.die("agent tokens are not served here"),
        saveSearch: () => Effect.die("saveSearch is not served here"),
        savedSearches: () => Effect.die("savedSearches is not served here"),
        setInstantAlerts: () => Effect.die("billing is not served here"),
        signInOptions: () => Effect.succeed({ socialProviders: [] }),
        startCheckout: () => Effect.die("billing is not served here"),
        trackJob: () => Effect.die("the tracker is not served here"),
        trackedJobs: () => Effect.die("the tracker is not served here"),
        untrackJob: () => Effect.die("the tracker is not served here"),
      }),
      RpcSerialization.layerJson,
    ])
  ),
  { disableLogger: true }
);

interface EdgeOptions {
  readonly backendStatus?: number;
  readonly indexing?: string;
}

const edge = (shell: string, options: EdgeOptions = {}) => {
  const calls = { assets: 0, backend: 0 };
  const pending: Promise<unknown>[] = [];
  const backendStatus = options.backendStatus ?? 200;

  const bindings = {
    ASSETS: {
      fetch: async () => {
        calls.assets += 1;

        return await Promise.resolve(new Response(shell));
      },
    },
    BACKEND: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.backend += 1;

        return backendStatus === 200
          ? await backend.handler(new Request(input, init))
          : new Response("down", { status: backendStatus });
      },
    },
    MCP_ANONYMOUS_LIMIT: unlimited,
    MCP_TOKEN_LIMIT: unlimited,
    SITE_INDEXING: options.indexing ?? "index",
  };

  const lifetime = {
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
  };

  const get = async (url: string, headers: Record<string, string> = {}) => {
    const response = await worker.fetch(
      new Request(url, { headers }),
      bindings,
      lifetime
    );

    const html = await response.text();

    await Promise.all(pending);

    return { headers: response.headers, html, status: response.status };
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
    expect(first.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=600"
    );
    expect(second.html).toBe(first.html);
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
    const page = await edge(indexHtml, { backendStatus: 503 }).get(ROLE_PAGE);

    expect(page.html).toBe(indexHtml);
    expect(stored.size).toBe(0);
  });

  it("keys a page on its route, so query strings share one render", async () => {
    const site = edge(indexHtml);

    const plain = await site.get(ROLE_PAGE);
    const tagged = await site.get(`${ROLE_PAGE}?utm_source=feed`);
    const busted = await site.get(`${ROLE_PAGE}?x=%E2%9C%93&shell=0`);

    expect(tagged.html).toBe(plain.html);
    expect(busted.html).toBe(plain.html);
    expect(site.calls.backend).toBe(1);
    expect(stored.size).toBe(1);
  });

  it.each([
    `${ORIGIN}/roles/director/remote%2Dcanada`,
    `${ORIGIN}/roles/%64irector/remote-canada`,
  ])(
    "answers the percent-encoded variant %s with an uncached 404",
    async (variant) => {
      const site = edge(indexHtml);

      await site.get(ROLE_PAGE);
      const page = await site.get(variant);

      expect(page.status).toBe(404);
      expect(stored.size).toBe(1);
    }
  );

  it("serves the trailing-slash variant from the canonical entry", async () => {
    const site = edge(indexHtml);

    const plain = await site.get(ROLE_PAGE);
    const slashed = await site.get(`${ROLE_PAGE}/`);

    expect(slashed.html).toBe(plain.html);
    expect(site.calls.backend).toBe(1);
    expect(stored.size).toBe(1);
  });
});

describe("not-found pages", () => {
  it.each([
    ["a pruned job", `${ORIGIN}${jobRouter({ id: "greenhouse:gone/1" })}`],
    ["a company with no open roles", `${ORIGIN}/companies/nobody-here`],
    ["a malformed job path", `${ORIGIN}/jobs/not!an!id`],
  ])("answers %s with an uncached 404", async (_case, url) => {
    const site = edge(indexHtml);

    const first = await site.get(url);
    const second = await site.get(url);

    expect(first.status).toBe(404);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(second.status).toBe(404);
    expect(stored.size).toBe(0);
  });

  it("asks the backend again for a job that was missing", async () => {
    const site = edge(indexHtml);
    const missing = `${ORIGIN}${jobRouter({ id: "greenhouse:gone/1" })}`;

    await site.get(missing);
    await site.get(missing);

    expect(site.calls.backend).toBe(2);
  });
});

describe("per-viewer requests", () => {
  it.each([{ cookie: "session=abc" }, { authorization: "Bearer abc" }])(
    "never stores a page rendered for a request with %o",
    async (credentials) => {
      const page = await edge(indexHtml).get(ROLE_PAGE, credentials);

      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("private, no-store");
      expect(stored.size).toBe(0);
    }
  );

  it("marks a cached page private when the request carries a cookie", async () => {
    const site = edge(indexHtml);

    const shared = await site.get(ROLE_PAGE);
    const personal = await site.get(ROLE_PAGE, { cookie: "session=abc" });

    expect(personal.html).toBe(shared.html);
    expect(personal.headers.get("cache-control")).toBe("private, no-store");
    expect(site.calls.backend).toBe(1);
  });

  it.each([
    `${ORIGIN}/account/confirm?token=secret`,
    `${ORIGIN}/`,
    `${ORIGIN}/shortlist`,
    `${ORIGIN}/jobs`,
  ])("passes %s to the assets without rendering or caching", async (url) => {
    const site = edge(indexHtml);

    const page = await site.get(url);

    expect(page.html).toBe(indexHtml);
    expect(site.calls.backend).toBe(0);
    expect(stored.size).toBe(0);
  });
});

describe("sitemap", () => {
  it("serves repeat sitemap requests from the cache", async () => {
    const site = edge(indexHtml);

    const first = await site.get(`${ORIGIN}/sitemap.xml`);
    const second = await site.get(`${ORIGIN}/sitemap.xml?refresh=1`);

    expect(first.status).toBe(200);
    expect(first.html).toContain("<urlset");
    expect(second.html).toBe(first.html);
    expect(site.calls.backend).toBe(1);
  });

  it("caches nothing when the backend is down", async () => {
    const page = await edge(indexHtml, { backendStatus: 503 }).get(
      `${ORIGIN}/sitemap.xml`
    );

    expect(page.status).toBe(503);
    expect(stored.size).toBe(0);
  });
});

describe("robots", () => {
  it("serves prod the same robots.txt as before, with no noindex header", async () => {
    const robots = await edge(indexHtml, { indexing: "index" }).get(
      `${ORIGIN}/robots.txt`
    );

    expect(robots.html).toBe(
      "User-agent: *\nAllow: /\nSitemap: https://jobs.example/sitemap.xml\n"
    );
    expect(robots.headers.has("x-robots-tag")).toBe(false);
  });

  it.each([
    `${ORIGIN}/robots.txt`,
    `${ORIGIN}/sitemap.xml`,
    ROLE_PAGE,
    `${ORIGIN}/`,
  ])("keeps crawlers off %s on a non-prod stage", async (url) => {
    const page = await edge(indexHtml, { indexing: "noindex" }).get(url);

    expect(page.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("disallows everything on a non-prod stage", async () => {
    const robots = await edge(indexHtml, { indexing: "noindex" }).get(
      `${ORIGIN}/robots.txt`
    );

    expect(robots.html).toBe("User-agent: *\nDisallow: /\n");
  });
});
