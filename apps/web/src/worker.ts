import { Effect, Option, Result, Schema } from "effect";
import { fromString } from "foldkit/url";

import { Route, routeOfUrl } from "./client/route.js";
import { findJob, listedJobs } from "./server/backend.js";
import type { ServiceBinding } from "./server/backend.js";
import { renderJobPage } from "./server/render.js";
import { robotsTxt, sitemapXml } from "./server/sitemap.js";

interface EdgeBindings {
  readonly ASSETS: ServiceBinding;
  readonly BACKEND: ServiceBinding;
}

const isRpc = (pathname: string) =>
  pathname === "/rpc" || pathname.startsWith("/rpc/");

const isJobRoute = Schema.is(Route.Job);

const jobIdOf = (href: string) =>
  Option.flatMap(fromString(href), (parsed) => {
    const route = routeOfUrl(parsed);

    return isJobRoute(route) ? Option.some(route.id) : Option.none();
  });

const respond = (body: string, contentType: string, status = 200) =>
  new Response(body, {
    headers: { "content-type": `${contentType}; charset=utf-8` },
    status,
  });

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
      const jobs = await Effect.runPromise(
        Effect.result(listedJobs(bindings.BACKEND))
      );

      return Result.isSuccess(jobs)
        ? respond(sitemapXml(url.origin, jobs.success), "application/xml")
        : respond("", "application/xml", 503);
    }

    const jobId = jobIdOf(request.url);

    if (Option.isNone(jobId)) {
      return await bindings.ASSETS.fetch(request);
    }

    const [shellResponse, job] = await Promise.all([
      bindings.ASSETS.fetch(new Request(new URL("/", url))),
      Effect.runPromise(Effect.result(findJob(bindings.BACKEND, jobId.value))),
    ]);

    if (Result.isFailure(job)) {
      return await bindings.ASSETS.fetch(request);
    }

    const page = renderJobPage(
      await shellResponse.text(),
      url.origin,
      url.pathname,
      job.success
    );

    return respond(page.html, "text/html", page.status);
  },
};
