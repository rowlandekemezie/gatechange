import { Effect, Option, Schema } from "effect";
import { fromString } from "foldkit/url";

import { Preload } from "./client/board/model.js";
import { collectListing, isListingRoute } from "./client/listing.js";
import { Route, routeOfUrl } from "./client/route.js";
import type { RouteValue } from "./client/route.js";
import { clientOf, listedJobs, shellOf } from "./server/backend.js";
import type { ServiceBinding } from "./server/backend.js";
import { renderPage } from "./server/render.js";
import { robotsTxt, sitemapXml } from "./server/sitemap.js";

interface EdgeBindings {
  readonly ASSETS: ServiceBinding;
  readonly BACKEND: ServiceBinding;
}

const isRpc = (pathname: string) =>
  pathname === "/rpc" || pathname.startsWith("/rpc/");

interface Lifetime {
  readonly waitUntil: (work: Promise<unknown>) => void;
}

const respond = (
  body: string,
  contentType: string,
  status = 200,
  headers: Record<string, string> = {}
) =>
  new Response(body, {
    headers: { ...headers, "content-type": `${contentType}; charset=utf-8` },
    status,
  });

const PAGE_CACHE = "pages";

const PAGE_CACHE_CONTROL = "public, max-age=0, s-maxage=600";

const hexOf = (digest: ArrayBuffer) =>
  [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const cachedPage = (url: URL, shell: string) =>
  // @effect-diagnostics-next-line asyncFunction:off -- The Workers Cache API and SubtleCrypto are Promise-based.
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(shell)
    );

    const keyUrl = new URL(url.href);

    keyUrl.searchParams.set("shell", hexOf(digest));

    const key = new Request(keyUrl);
    const cache = await caches.open(PAGE_CACHE);

    return { cache, hit: await cache.match(key), key };
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

const servePage = (bindings: EdgeBindings, url: URL, lifetime: Lifetime) =>
  Effect.gen(function* serveRenderedPage() {
    const route = routeOfUrl(yield* Effect.fromOption(fromString(url.href)));
    const shell = yield* shellOf(bindings.ASSETS, url.origin);
    const { cache, hit, key } = yield* cachedPage(url, shell);

    if (hit !== undefined) {
      return Option.some(hit);
    }

    const preload = yield* preloadOf(bindings.BACKEND, route);
    const page = yield* renderPage(shell, url, route, preload);

    const response = respond(page.html, "text/html", page.status, {
      "cache-control": PAGE_CACHE_CONTROL,
    });

    yield* Effect.sync(() => {
      lifetime.waitUntil(cache.put(key, response.clone()));
    });

    return Option.some(response);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logError("page render fell back to the SPA shell", cause),
        Option.none<Response>()
      )
    )
  );

const serveSitemap = (bindings: EdgeBindings, url: URL) =>
  listedJobs(bindings.BACKEND).pipe(
    Effect.match({
      onFailure: () => respond("", "application/xml", 503),
      onSuccess: (jobs) =>
        respond(sitemapXml(url.origin, jobs), "application/xml"),
    })
  );

export default {
  // @effect-diagnostics-next-line asyncFunction:off -- Cloudflare's module Worker contract is a Promise-returning fetch handler.
  fetch: async (
    request: Request,
    bindings: EdgeBindings,
    lifetime: Lifetime
  ): Promise<Response> => {
    const url = new URL(request.url);

    if (isRpc(url.pathname)) {
      return await bindings.BACKEND.fetch(request);
    }

    if (url.pathname === "/robots.txt") {
      return respond(robotsTxt(url.origin), "text/plain");
    }

    if (url.pathname === "/sitemap.xml") {
      return await Effect.runPromise(serveSitemap(bindings, url));
    }

    const page = await Effect.runPromise(servePage(bindings, url, lifetime));

    return Option.isSome(page)
      ? page.value
      : await bindings.ASSETS.fetch(request);
  },
};
