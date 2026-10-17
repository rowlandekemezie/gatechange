import { Effect } from "effect";

export interface Lifetime {
  readonly waitUntil: (work: Promise<unknown>) => void;
}

const EDGE_CACHE = "pages";

const SHARED = "public, max-age=0, s-maxage=600";

const PERSONAL = "private, no-store";

const carriesCredentials = (request: Request) =>
  request.headers.has("cookie") || request.headers.has("authorization");

const isShareable = (request: Request, response: Response) =>
  response.status === 200 &&
  !carriesCredentials(request) &&
  !response.headers.has("set-cookie");

const withCacheControl = (response: Response, cacheControl: string) => {
  const copy = new Response(response.body, response);

  copy.headers.set("cache-control", cacheControl);

  return copy;
};

const lookUp = (key: Request) =>
  // @effect-diagnostics-next-line asyncFunction:off -- The Workers Cache API is Promise-based.
  Effect.promise(async () => {
    const cache = await caches.open(EDGE_CACHE);

    return { cache, hit: await cache.match(key) };
  });

export const throughEdgeCache = <E, R>(
  request: Request,
  key: Request,
  lifetime: Lifetime,
  produce: Effect.Effect<Response, E, R>
) =>
  Effect.gen(function* serveThroughEdgeCache() {
    const { cache, hit } = yield* lookUp(key);

    if (hit !== undefined) {
      return carriesCredentials(request)
        ? withCacheControl(hit, PERSONAL)
        : hit;
    }

    const response = yield* produce;

    if (!isShareable(request, response)) {
      return withCacheControl(response, PERSONAL);
    }

    const shared = withCacheControl(response, SHARED);

    yield* Effect.sync(() => {
      lifetime.waitUntil(cache.put(key, shared.clone()));
    });

    return shared;
  });
