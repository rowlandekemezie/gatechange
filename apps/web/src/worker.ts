import { edgeRouteOf, PRIVATE_CACHE_CONTROL } from "./edge-routes.js";
import type { EdgeRoute } from "./edge-routes.js";

interface ServiceBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}

interface EdgeBindings {
  readonly ASSETS: ServiceBinding;
  readonly BACKEND: ServiceBinding;
}

const withoutSharedCache = (route: EdgeRoute, response: Response) => {
  if (route === "public" && !response.headers.has("set-cookie")) {
    return response;
  }

  const guarded = new Response(response.body, response);

  guarded.headers.set("cache-control", PRIVATE_CACHE_CONTROL);

  return guarded;
};

export default {
  // @effect-diagnostics-next-line asyncFunction:off -- Cloudflare's module Worker contract is a Promise-returning fetch handler.
  fetch: async (
    request: Request,
    bindings: EdgeBindings
  ): Promise<Response> => {
    const route = edgeRouteOf(new URL(request.url).pathname);

    const response =
      route === "backend"
        ? await bindings.BACKEND.fetch(request)
        : await bindings.ASSETS.fetch(request);

    return withoutSharedCache(route, response);
  },
};
