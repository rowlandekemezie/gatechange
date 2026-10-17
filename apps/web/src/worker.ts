interface ServiceBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}

interface EdgeBindings {
  readonly ASSETS: ServiceBinding;
  readonly BACKEND: ServiceBinding;
}

const backendPrefixes = ["/rpc", "/api/auth"];

const isBackend = (pathname: string) =>
  backendPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

export default {
  // @effect-diagnostics-next-line asyncFunction:off -- Cloudflare's module Worker contract is a Promise-returning fetch handler.
  fetch: async (request: Request, bindings: EdgeBindings): Promise<Response> =>
    isBackend(new URL(request.url).pathname)
      ? await bindings.BACKEND.fetch(request)
      : await bindings.ASSETS.fetch(request),
};
