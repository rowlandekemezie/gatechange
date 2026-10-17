import { Effect, Option, Schema } from "effect";
import { fromString } from "foldkit/url";

import { Preload } from "./client/board/model.js";
import { collectListing, isListingRoute } from "./client/listing.js";
import { canonicalPathOf, Route, routeOfUrl } from "./client/route.js";
import type { RouteValue } from "./client/route.js";
import { edgeRouteOf, PRIVATE_CACHE_CONTROL } from "./edge-routes.js";
import type { EdgeRoute } from "./edge-routes.js";
import { clientOf, listedJobs, shellOf } from "./server/backend.js";
import type { ServiceBinding } from "./server/backend.js";
import { throughEdgeCache } from "./server/edge-cache.js";
import type { Lifetime } from "./server/edge-cache.js";
import { renderPage } from "./server/render.js";
import { closedRobotsTxt, robotsTxt, sitemapXml } from "./server/sitemap.js";

interface EdgeBindings {
  readonly ASSETS: ServiceBinding;
  readonly BACKEND: ServiceBinding;
  readonly SITE_INDEXING?: string;
}

const withoutSharedCache = (route: EdgeRoute, response: Response) => {
  if (route === "public" && !response.headers.has("set-cookie")) {
    return response;
  }

  const guarded = new Response(response.body, response);

  guarded.headers.set("cache-control", PRIVATE_CACHE_CONTROL);

  return guarded;
};

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
      const client = yield* clientOf(backend);

      if (Schema.is(Route.Job)(route)) {
        const job = yield* client.getJob({ id: route.id });

        return Option.match(job, {
          onNone: () => Preload.JobMissing(),
          onSome: (found) => Preload.Job({ job: found }),
        });
      }

      if (isListingRoute(route)) {
        const listing = yield* collectListing(
          (query) => client.listJobs(query),
          route
        );

        return Preload.Listing(listing);
      }

      return Preload.Nothing();
    })
  );

const PAGE_PREFIXES = ["/jobs/", "/companies/", "/roles/"];

const isPage = (pathname: string) =>
  PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix));

const servePage = (
  bindings: EdgeBindings,
  request: Request,
  url: URL,
  lifetime: Lifetime
) =>
  Effect.gen(function* serveRenderedPage() {
    const route = routeOfUrl(yield* Effect.fromOption(fromString(url.href)));

    const pageUrl = new URL(
      Option.getOrElse(canonicalPathOf(route), () => url.pathname),
      url.origin
    );

    const shell = yield* shellOf(bindings.ASSETS, url.origin);
    const key = yield* pageKeyOf(pageUrl, shell);

    return Option.some(
      yield* throughEdgeCache(
        request,
        key,
        lifetime,
        Effect.gen(function* renderFreshPage() {
          const preload = yield* preloadOf(bindings.BACKEND, route);
          const page = yield* renderPage(shell, pageUrl, route, preload);

          return respond(page.html, "text/html", page.status);
        })
      )
    );
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

const serveSite = (
  request: Request,
  bindings: EdgeBindings,
  lifetime: Lifetime
): Effect.Effect<Option.Option<Response>> => {
  const url = new URL(request.url);

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
    return Effect.asSome(serveSitemap(bindings, request, url, lifetime));
  }

  return isPage(url.pathname)
    ? servePage(bindings, request, url, lifetime)
    : Effect.succeedNone;
};

const noindex = (response: Response) => {
  const copy = new Response(response.body, response);

  copy.headers.set("x-robots-tag", "noindex");

  return copy;
};

export default {
  // @effect-diagnostics-next-line asyncFunction:off -- Cloudflare's module Worker contract is a Promise-returning fetch handler.
  fetch: async (
    request: Request,
    bindings: EdgeBindings,
    lifetime: Lifetime
  ): Promise<Response> => {
    const route = edgeRouteOf(new URL(request.url).pathname);

    if (route === "backend") {
      return withoutSharedCache(route, await bindings.BACKEND.fetch(request));
    }

    const served =
      route === "public"
        ? await Effect.runPromise(serveSite(request, bindings, lifetime))
        : Option.none<Response>();

    const response = withoutSharedCache(
      route,
      Option.isSome(served)
        ? served.value
        : await bindings.ASSETS.fetch(request)
    );

    return bindings.SITE_INDEXING === "index" ? response : noindex(response);
  },
};
