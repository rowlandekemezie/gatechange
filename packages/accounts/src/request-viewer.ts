import { Viewer } from "@rat-stack/core";
import type {
  AccountStore,
  RequestHeaders,
  ViewerValue,
} from "@rat-stack/core";
import { Config, Data, Effect, Schema } from "effect";

import { hasSessionCookie } from "./account-store.js";
import { isCrossSite } from "./cross-site.js";

export const MIN_AUTH_SECRET_LENGTH = 32;

export const authSecret = Config.schema(
  Schema.Redacted(
    Schema.String.check(Schema.isMinLength(MIN_AUTH_SECRET_LENGTH))
  ),
  "BETTER_AUTH_SECRET"
);

export class CrossSiteRequest extends Data.TaggedError("CrossSiteRequest") {}

export const viewerOfRequest = (
  store: AccountStore["Service"],
  headers: RequestHeaders
): Effect.Effect<ViewerValue, CrossSiteRequest> =>
  hasSessionCookie(headers) && isCrossSite(headers)
    ? Effect.fail(new CrossSiteRequest())
    : store
        .viewerOf(headers)
        .pipe(
          Effect.catchTag("AccountStoreUnavailable", (failure) =>
            Effect.logWarning("session lookup failed", failure).pipe(
              Effect.as(Viewer.Anonymous())
            )
          )
        );
