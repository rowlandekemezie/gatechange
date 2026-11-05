import type { RequestHeaders } from "@rat-stack/core";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

import { MAGIC_LINK_PREVIEW_PATH } from "./link-preview.js";

const SAME_SITE_FETCHES: ReadonlySet<string> = new Set(["same-origin", "none"]);

const SAME_ORIGIN_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/magic-link/verify",
  MAGIC_LINK_PREVIEW_PATH,
]);

const isSameOrigin = (headers: Headers | undefined) =>
  headers?.get("sec-fetch-site") === "same-origin";

interface RateRule {
  readonly max: number;
  readonly window: number;
}

const unlessCrossSite = (request: Request, rule: RateRule) =>
  isSameOrigin(request.headers) ? rule : false;

export const sameOriginRateRules = Object.fromEntries(
  [...SAME_ORIGIN_ONLY_PATHS].map((path) => [path, unlessCrossSite])
);

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
          await (isSameOrigin(ctx.headers)
            ? Promise.resolve()
            : Promise.reject(
                new APIError("FORBIDDEN", {
                  message:
                    "Open the sign-in link from your email in an up-to-date browser.",
                })
              ));
        }),
        matcher: (context) => SAME_ORIGIN_ONLY_PATHS.has(context.path ?? ""),
      },
    ],
  },
  id: "same-site-verify",
});
