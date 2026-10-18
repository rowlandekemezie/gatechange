import { Viewer } from "@rat-stack/core";
import type { AccountStore, ViewerValue } from "@rat-stack/core";
import { Config, Effect, Schema } from "effect";

export const MIN_AUTH_SECRET_LENGTH = 32;

export const authSecret = Config.schema(
  Schema.Redacted(
    Schema.String.check(Schema.isMinLength(MIN_AUTH_SECRET_LENGTH))
  ),
  "BETTER_AUTH_SECRET"
);

export const viewerOfCookie = (
  store: AccountStore["Service"],
  cookie: string | undefined
): Effect.Effect<ViewerValue> =>
  store
    .viewerOf(cookie ?? "")
    .pipe(
      Effect.catchTag("AccountStoreUnavailable", (failure) =>
        Effect.logWarning("session lookup failed", failure).pipe(
          Effect.as(Viewer.Anonymous())
        )
      )
    );
