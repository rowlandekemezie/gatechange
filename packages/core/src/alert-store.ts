import { Context } from "effect";
import type { Effect, Option } from "effect";

import type { AccountIdValue } from "./account.js";
import type {
  DigestRecipient,
  SavedSearchIdValue,
  SavedSearchValue,
  SearchFiltersValue,
} from "./alerts.js";
import type { JobStoreUnavailable } from "./job-store-unavailable.js";
import type { JobValue } from "./job.js";

export class AlertStore extends Context.Service<
  AlertStore,
  {
    readonly claimDigest: (
      account: AccountIdValue,
      periodStart: number,
      now: number
    ) => Effect.Effect<boolean, JobStoreUnavailable>;
    readonly deleteSearch: (
      owner: AccountIdValue,
      id: SavedSearchIdValue
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly dueRecipients: (
      periodStart: number,
      now: number
    ) => Effect.Effect<readonly DigestRecipient[], JobStoreUnavailable>;
    readonly jobsSeenSince: (
      since: number
    ) => Effect.Effect<readonly JobValue[], JobStoreUnavailable>;
    readonly markSent: (
      account: AccountIdValue,
      periodStart: number,
      sentAt: number,
      jobs: number
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly releaseDigest: (
      account: AccountIdValue,
      periodStart: number
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly saveSearch: (
      owner: AccountIdValue,
      filters: SearchFiltersValue,
      createdAt: number,
      limit: number
    ) => Effect.Effect<Option.Option<SavedSearchValue>, JobStoreUnavailable>;
    readonly searchesOf: (
      owner: AccountIdValue
    ) => Effect.Effect<readonly SavedSearchValue[], JobStoreUnavailable>;
    readonly sendsSince: (
      since: number
    ) => Effect.Effect<number, JobStoreUnavailable>;
    readonly unsubscribe: (
      account: AccountIdValue,
      at: number
    ) => Effect.Effect<void, JobStoreUnavailable>;
  }
>()("@rat-stack/core/AlertStore") {}
