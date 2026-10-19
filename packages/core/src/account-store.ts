import { Context } from "effect";
import type { Effect } from "effect";

import type { AccountStoreUnavailable } from "./account-store-unavailable.js";
import type { SignInOptionsValue, ViewerValue } from "./account.js";

export type RequestHeaders = Readonly<Record<string, string | undefined>>;

export class AccountStore extends Context.Service<
  AccountStore,
  {
    readonly signInOptions: SignInOptionsValue;
    readonly viewerOf: (
      headers: RequestHeaders
    ) => Effect.Effect<ViewerValue, AccountStoreUnavailable>;
  }
>()("@rat-stack/core/AccountStore") {}
