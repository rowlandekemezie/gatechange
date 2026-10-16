interface ServiceBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}

interface EdgeBindings {
  readonly ASSETS: ServiceBinding;
  readonly BACKEND: ServiceBinding;
}

const isRpc = (pathname: string) => pathname === "/rpc" || pathname.startsWith("/rpc/");

export default {
  // @effect-diagnostics-next-line asyncFunction:off -- Cloudflare's module Worker contract is a Promise-returning fetch handler.
  fetch: async (request: Request, bindings: EdgeBindings): Promise<Response> =>
    isRpc(new URL(request.url).pathname)
      ? await bindings.BACKEND.fetch(request)
      : await bindings.ASSETS.fetch(request),
};
