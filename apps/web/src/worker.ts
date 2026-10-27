import { canonicalSiteUrlOf } from "@rat-stack/core";
import { Effect, Option, Schema } from "effect";
import { fromString } from "foldkit/url";

import { hasNoSelection, queryOf } from "./client/board/filters.js";
import { Preload } from "./client/board/model.js";
import { collectListing, isListingRoute } from "./client/listing.js";
import { canonicalPathOf, Route, routeOfUrl } from "./client/route.js";
import type { RouteValue } from "./client/route.js";
import {
  CANONICAL_REDIRECT_CACHE_CONTROL,
  edgeRouteOf,
  HASHED_ASSET_CACHE_CONTROL,
  PRIVATE_CACHE_CONTROL,
  PRIVATE_REFERRER_POLICY,
  UNREDIRECTED_PATHS,
} from "./edge-routes.js";
import type { EdgeRoute } from "./edge-routes.js";
import {
  analyticsOf,
  proxyIngest,
  withAnalyticsKey,
} from "./server/analytics.js";
import type { AnalyticsBindings } from "./server/analytics.js";
import { clientOf, listedJobs, shellOf } from "./server/backend.js";
import type { ServiceBinding } from "./server/backend.js";
import { throughEdgeCache } from "./server/edge-cache.js";
import type { Lifetime } from "./server/edge-cache.js";
import { backendOf } from "./server/preview-backend.js";
import { renderPage } from "./server/render.js";
import {
  closedRobotsTxt,
  emptySitemapXml,
  robotsTxt,
  sitemapXml,
} from "./server/sitemap.js";

interface RateLimiter {
  readonly limit: (options: {
    readonly key: string;
  }) => Promise<{ readonly success: boolean }>;
}

interface EdgeBindings extends AnalyticsBindings {
  readonly ASSETS: ServiceBinding;
  readonly BACKEND: ServiceBinding;
  readonly MCP_ANONYMOUS_LIMIT: RateLimiter;
  readonly MCP_TOKEN_LIMIT: RateLimiter;
  readonly SITE_INDEXING?: string;
}

interface WorkerBindings extends Omit<EdgeBindings, "BACKEND"> {
  readonly BACKEND?: ServiceBinding;
  readonly PR_PREVIEW_BACKEND_URL?: string;
  readonly PR_PREVIEW_SECRET?: string;
}

const withoutSharedCache = (route: EdgeRoute, response: Response) => {
  if (route === "public" && !response.headers.has("set-cookie")) {
    return response;
  }

  const guarded = new Response(response.body, response);

  guarded.headers.set("cache-control", PRIVATE_CACHE_CONTROL);

  if (route === "private") {
    guarded.headers.set("referrer-policy", PRIVATE_REFERRER_POLICY);
  }

  return guarded;
};

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

const redirectTo = (request: Request, location: URL) =>
  new Response(null, {
    headers: {
      "cache-control": CANONICAL_REDIRECT_CACHE_CONTROL,
      location: location.href,
    },
    status: SAFE_METHODS.has(request.method) ? 301 : 308,
  });

const respond = (body: string, contentType: string, status = 200) =>
  new Response(body, {
    headers: { "content-type": `${contentType}; charset=utf-8` },
    status,
  });

const hexOf = (digest: ArrayBuffer) =>
  [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const pageKeyOf = (pageUrl: URL, shell: string) =>
  // @effect-diagnostics-next-line asyncFunction:off -- SubtleCrypto is Promise-based.
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(shell)
    );

    const keyUrl = new URL(pageUrl);

    keyUrl.searchParams.set("shell", hexOf(digest));

    return new Request(keyUrl);
  });

const preloadOf = (backend: ServiceBinding, route: RouteValue) =>
  Effect.scoped(
    Effect.gen(function* fetchPreload() {
      if (
        Schema.is(Route.Pricing)(route) ||
        Schema.is(Route.Information)(route) ||
        Schema.is(Route.NotFound)(route)
      ) {
        return Preload.Nothing();
      }

      const client = yield* clientOf(backend);

      if (Schema.is(Route.Board)(route)) {
        const { page, stats } = yield* Effect.all(
          {
            page: hasNoSelection(route.filters)
              ? Effect.succeed({ generatedAt: 0, jobs: [], total: 0 })
              : client.listJobs(queryOf(route.filters, 0)),
            stats: client
              .boardStats({})
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("board stats unavailable", cause).pipe(
                    Effect.as(null)
                  )
                )
              ),
          },
          { concurrency: 2 }
        );

        return Preload.Board({ ...page, filters: route.filters, stats });
      }

      if (Schema.is(Route.Job)(route)) {
        const job = yield* client.getJob({ id: route.id });

        return Option.match(job, {
          onNone: () => Preload.JobMissing(),
          onSome: (found) => Preload.Job({ job: found }),
        });
      }

      if (isListingRoute(route)) {
        const listing = yield* collectListing(
          {
            companyJobs: (slug) => client.companyJobs({ slug }),
            listJobs: (query) => client.listJobs(query),
          },
          route
        );

        return Preload.Listing(listing);
      }

      return Preload.Nothing();
    })
  );

const PAGE_PREFIXES = ["/jobs/", "/companies/", "/roles/"];

const isPage = (pathname: string) =>
  ["/", "/pricing", "/about", "/privacy", "/terms", "/contact"].includes(
    pathname
  ) || PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix));

const servePage = (
  bindings: EdgeBindings,
  request: Request,
  url: URL,
  lifetime: Lifetime
) =>
  Effect.gen(function* serveRenderedPage() {
    const route = routeOfUrl(yield* Effect.fromOption(fromString(url.href)));

    const pageUrl = Schema.is(Route.Board)(route)
      ? url
      : new URL(
          Option.getOrElse(canonicalPathOf(route), () => url.pathname),
          url.origin
        );

    const shell = yield* shellOf(bindings.ASSETS, url.origin);

    const fresh = Effect.gen(function* renderFreshPage() {
      const preload = yield* preloadOf(bindings.BACKEND, route);
      const page = yield* renderPage(shell, pageUrl, route, preload);

      return respond(page.html, "text/html", page.status);
    });

    if (Schema.is(Route.Board)(route) && url.search !== "") {
      const response = yield* fresh;

      response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);

      return Option.some(response);
    }

    const key = yield* pageKeyOf(pageUrl, shell);

    return Option.some(yield* throughEdgeCache(request, key, lifetime, fresh));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logError("page render fell back to the SPA shell", cause),
        Option.none<Response>()
      )
    )
  );

const serveSitemap = (
  bindings: EdgeBindings,
  request: Request,
  url: URL,
  lifetime: Lifetime
) =>
  throughEdgeCache(
    request,
    new Request(new URL("/sitemap.xml", url.origin)),
    lifetime,
    listedJobs(bindings.BACKEND).pipe(
      Effect.match({
        onFailure: () => respond("", "application/xml", 503),
        onSuccess: (jobs) =>
          respond(sitemapXml(url.origin, jobs), "application/xml"),
      })
    )
  );

const noindex = (response: Response) => {
  const copy = new Response(response.body, response);

  copy.headers.set("x-robots-tag", "noindex");

  return copy;
};

const TRACKING_PARAMS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref"]);

const isTrackingParam = (name: string) =>
  TRACKING_PARAMS.has(name) || name.startsWith("utm_");

const siteUrlOf = (request: Request) => {
  const url = new URL(request.url);
  const tracking = [...url.searchParams.keys()].filter(isTrackingParam);

  for (const name of tracking) {
    url.searchParams.delete(name);
  }

  return url;
};

const FILE_PATH = /\.[^/]*$/u;

const fetchAsset = (bindings: EdgeBindings, input: Request | URL) =>
  // @effect-diagnostics-next-line asyncFunction:off -- The ASSETS binding is Promise-based.
  Effect.promise(async () => await bindings.ASSETS.fetch(input));

const serveUnmatched = (
  bindings: EdgeBindings,
  request: Request,
  url: URL,
  lifetime: Lifetime
) =>
  Effect.gen(function* serveUnmatchedPath() {
    const asset = yield* fetchAsset(bindings, request);

    if (asset.ok && url.pathname.startsWith("/assets/")) {
      const immutable = new Response(asset.body, asset);

      immutable.headers.set("cache-control", HASHED_ASSET_CACHE_CONTROL);

      return immutable;
    }

    if (asset.status !== 404 || FILE_PATH.test(url.pathname)) {
      return asset;
    }

    const unknown = Option.exists(fromString(url.href), (parsed) =>
      Schema.is(Route.NotFound)(routeOfUrl(parsed))
    );

    const page = unknown
      ? yield* servePage(bindings, request, url, lifetime)
      : Option.none<Response>();

    if (Option.isSome(page)) {
      return page.value;
    }

    const shell = yield* fetchAsset(bindings, new URL("/", url.origin));

    return isPage(url.pathname) ? shell : noindex(shell);
  });

const serveSite = (
  request: Request,
  url: URL,
  bindings: EdgeBindings,
  lifetime: Lifetime
): Effect.Effect<Option.Option<Response>> => {
  if (url.pathname === "/robots.txt") {
    return Effect.succeedSome(
      respond(
        bindings.SITE_INDEXING === "index"
          ? robotsTxt(url.origin)
          : closedRobotsTxt,
        "text/plain"
      )
    );
  }

  if (url.pathname === "/sitemap.xml") {
    if (bindings.SITE_INDEXING !== "index") {
      return Effect.succeedSome(respond(emptySitemapXml, "application/xml"));
    }

    return Effect.asSome(serveSitemap(bindings, request, url, lifetime));
  }

  return isPage(url.pathname)
    ? servePage(bindings, request, url, lifetime)
    : Effect.succeedNone;
};

const RETRY_AFTER_SECONDS = 60;

// @effect-diagnostics-next-line asyncFunction:off -- The Rate Limiting binding is Promise-based.
const agentCallAllowed = async (request: Request, bindings: EdgeBindings) => {
  const limiter = request.headers.has("authorization")
    ? bindings.MCP_TOKEN_LIMIT
    : bindings.MCP_ANONYMOUS_LIMIT;

  const caller = request.headers.get("cf-connecting-ip") ?? "unknown";

  const { success } = await limiter.limit({
    key: `${new URL(request.url).host}|${caller}`,
  });

  return success;
};

const tooManyAgentCalls = (request: Request) =>
  Response.json(
    {
      error: {
        code: -32_029,
        message: request.headers.has("authorization")
          ? `Too many MCP calls from this address. Retry in ${RETRY_AFTER_SECONDS} seconds.`
          : `Too many MCP calls from this address without a token. Retry in ${RETRY_AFTER_SECONDS} seconds, or connect with a Pro token for a higher limit.`,
      },
      id: null,
      jsonrpc: "2.0",
    },
    { headers: { "retry-after": String(RETRY_AFTER_SECONDS) }, status: 429 }
  );

export default {
  // @effect-diagnostics-next-line asyncFunction:off -- Cloudflare's module Worker contract is a Promise-returning fetch handler.
  fetch: async (
    request: Request,
    environment: WorkerBindings,
    lifetime: Lifetime
  ): Promise<Response> => {
    const requested = new URL(request.url);

    const canonical = UNREDIRECTED_PATHS.has(requested.pathname)
      ? Option.none<URL>()
      : canonicalSiteUrlOf(requested);

    if (Option.isSome(canonical)) {
      return redirectTo(request, canonical.value);
    }

    const backend = backendOf(environment, globalThis.fetch);

    if (backend === undefined) {
      return respond("Preview backend unavailable", "text/plain", 503);
    }

    const bindings: EdgeBindings = { ...environment, BACKEND: backend };
    const url = siteUrlOf(request);
    const route = edgeRouteOf(url.pathname);

    if (route === "agent") {
      return withoutSharedCache(
        route,
        (await agentCallAllowed(request, bindings))
          ? await bindings.BACKEND.fetch(request)
          : tooManyAgentCalls(request)
      );
    }

    if (route === "analytics") {
      return await Effect.runPromise(
        proxyIngest(request, analyticsOf(bindings), globalThis.fetch)
      );
    }

    if (route === "backend") {
      return withoutSharedCache(route, await bindings.BACKEND.fetch(request));
    }

    const served =
      route === "public"
        ? await Effect.runPromise(serveSite(request, url, bindings, lifetime))
        : Option.none<Response>();

    const response = await Effect.runPromise(
      withAnalyticsKey(
        withoutSharedCache(
          route,
          Option.isSome(served)
            ? served.value
            : await Effect.runPromise(
                serveUnmatched(bindings, request, url, lifetime)
              )
        ),
        analyticsOf(bindings)
      )
    );

    const filteredBoard = url.pathname === "/" && url.search !== "";

    return bindings.SITE_INDEXING === "index" &&
      !filteredBoard &&
      response.status !== 404
      ? response
      : noindex(response);
  },
};
