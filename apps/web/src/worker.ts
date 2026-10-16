interface ServiceBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}

interface EdgeBindings {
  readonly ASSETS: ServiceBinding;
  readonly BACKEND: ServiceBinding;
}

const isRpc = (pathname: string) => pathname === "/rpc" || pathname.startsWith("/rpc/");

export default {
  fetch: (request: Request, bindings: EdgeBindings): Promise<Response> =>
    isRpc(new URL(request.url).pathname)
      ? bindings.BACKEND.fetch(request)
      : bindings.ASSETS.fetch(request),
};
