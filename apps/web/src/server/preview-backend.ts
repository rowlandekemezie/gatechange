import { SITE_WORKERS_SUBDOMAIN } from "@rat-stack/core";

import type { ServiceBinding } from "./backend.js";

interface BackendBindings {
  readonly BACKEND?: ServiceBinding;
  readonly PR_PREVIEW_BACKEND_URL?: string;
  readonly PR_PREVIEW_SECRET?: string;
}

export const backendOf = (
  bindings: BackendBindings,
  transport: typeof globalThis.fetch
): ServiceBinding | undefined => {
  const endpoint = bindings.PR_PREVIEW_BACKEND_URL;
  const secret = bindings.PR_PREVIEW_SECRET;

  if (endpoint === undefined && secret === undefined) {
    return bindings.BACKEND;
  }

  const destination = endpoint === undefined ? null : URL.parse(endpoint);

  if (
    destination === null ||
    destination.protocol !== "https:" ||
    !destination.hostname.endsWith(`.${SITE_WORKERS_SUBDOMAIN}.workers.dev`) ||
    !/^pr-[1-9][0-9]*-/u.test(destination.hostname) ||
    destination.port !== "" ||
    destination.username !== "" ||
    destination.password !== "" ||
    secret === undefined ||
    secret.length < 32
  ) {
    return undefined;
  }

  return {
    // @effect-diagnostics-next-line asyncFunction:off -- The Workers Fetch binding requires a Promise-returning handler.
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const original = new URL(request.url);
      const url = new URL(destination.origin);
      url.pathname = original.pathname;
      url.search = original.search;
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.set("x-jobs-preview-secret", secret);

      return await transport(
        new Request(new Request(url, request), {
          headers,
          redirect: "manual",
        })
      );
    },
  };
};
