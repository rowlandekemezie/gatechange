import { Context } from "effect";
import type { Effect, Option } from "effect";

import type { AccountValue } from "./account.js";
import type { JobStoreUnavailable } from "./job-store-unavailable.js";

export const OAUTH_ACCESS_TOKEN_PREFIX = "jobs_oat_";

export const OAUTH_REFRESH_TOKEN_PREFIX = "jobs_ort_";

export class OAuthAccessTokens extends Context.Service<
  OAuthAccessTokens,
  {
    readonly holderOf: (
      accessToken: string,
      resource: string
    ) => Effect.Effect<Option.Option<AccountValue>, JobStoreUnavailable>;
  }
>()("@rat-stack/core/OAuthAccessTokens") {}
