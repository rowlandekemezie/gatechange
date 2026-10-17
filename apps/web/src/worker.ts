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

const respond = (body: string, contentType: string, status = 200) =>
  new Response(body, {
    headers: { "content-type": `${contentType}; charset=utf-8` },
    status,
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

const servePage = (bindings: EdgeBindings, url: URL) =>
  Effect.gen(function* serveRenderedPage() {
    const route = routeOfUrl(yield* Effect.fromOption(fromString(url.href)));

    const [shell, preload] = yield* Effect.all(
      [
        shellOf(bindings.ASSETS, url.origin),
        preloadOf(bindings.BACKEND, route),
      ],
      { concurrency: 2 }
    );

    const page = yield* renderPage(shell, url, route, preload);

    return Option.some(respond(page.html, "text/html", page.status));
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
    bindings: EdgeBindings
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

    const page = await Effect.runPromise(servePage(bindings, url));

    return Option.isSome(page)
      ? page.value
      : await bindings.ASSETS.fetch(request);
  },
};
