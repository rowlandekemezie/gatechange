import { Context } from "effect";
import type { Effect, Option } from "effect";

import type { AccountIdValue } from "./account.js";
import type {
  CadenceValue,
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
      cadence: CadenceValue,
      account: AccountIdValue,
      periodStart: number,
      now: number,
      dailyLimit: number
    ) => Effect.Effect<boolean, JobStoreUnavailable>;
    readonly deleteSearch: (
      owner: AccountIdValue,
      id: SavedSearchIdValue
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly dueRecipients: (
      cadence: CadenceValue,
      periodStart: number,
      now: number,
      account?: AccountIdValue
    ) => Effect.Effect<readonly DigestRecipient[], JobStoreUnavailable>;
    readonly jobsSeenSince: (
      since: number
    ) => Effect.Effect<readonly JobValue[], JobStoreUnavailable>;
    readonly instantAlertsOf: (
      account: AccountIdValue
    ) => Effect.Effect<boolean, JobStoreUnavailable>;
    readonly markSent: (
      cadence: CadenceValue,
      account: AccountIdValue,
      periodStart: number,
      sentAt: number,
      jobs: number
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly releaseDigest: (
      cadence: CadenceValue,
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
    readonly setInstantAlerts: (
      account: AccountIdValue,
      enabled: boolean,
      at: number
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly sendsSince: (
      cadence: CadenceValue,
      since: number
    ) => Effect.Effect<number, JobStoreUnavailable>;
    readonly unsubscribe: (
      account: AccountIdValue,
      at: number
    ) => Effect.Effect<void, JobStoreUnavailable>;
  }
>()("@rat-stack/core/AlertStore") {}
