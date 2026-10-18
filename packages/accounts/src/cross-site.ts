import type { RequestHeaders } from "@rat-stack/core";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

const SAME_SITE_FETCHES: ReadonlySet<string> = new Set(["same-origin", "none"]);

const hostOfOrigin = (origin: string) =>
  URL.canParse(origin) ? new URL(origin).host : undefined;

export const isCrossSite = (headers: RequestHeaders) => {
  const fetchSite = headers["sec-fetch-site"];

  if (fetchSite !== undefined) {
    return !SAME_SITE_FETCHES.has(fetchSite);
  }

  const { host, origin } = headers;

  return (
    origin !== undefined && host !== undefined && hostOfOrigin(origin) !== host
  );
};

export const sameSiteVerify = (): BetterAuthPlugin => ({
  hooks: {
    before: [
      {
        // @effect-diagnostics-next-line asyncFunction:off -- better-auth hooks are Promise-returning middleware.
        handler: createAuthMiddleware(async (ctx) => {
          await (isCrossSite(Object.fromEntries(ctx.headers ?? []))
            ? Promise.reject(
                new APIError("FORBIDDEN", {
                  message: "Open the sign-in link from your email.",
                })
              )
            : Promise.resolve());
        }),
        matcher: (context) => context.path === "/magic-link/verify",
      },
    ],
  },
  id: "same-site-verify",
});
