import { implement } from "@rat-stack/capability/implement";
import { Clock, Effect } from "effect";
import type { Effect as EffectType } from "effect";

import { AccountStore } from "./account-store.js";
import { currentMember } from "./account.js";
import type { AccountIdValue } from "./account.js";
import { AlertStore } from "./alert-store.js";
import { MAX_SAVED_SEARCHES } from "./alerts.js";
import {
  accountContract,
  boardStatsContract,
  deleteSearchContract,
  getJobContract,
  importShortlistContract,
  listJobsContract,
  noteTrackedJobContract,
  savedSearchesContract,
  saveSearchContract,
  signInOptionsContract,
  trackedJobsContract,
  trackJobContract,
  untrackJobContract,
} from "./contracts.js";
import type { JobStoreUnavailable } from "./job-store-unavailable.js";
import { JobStore } from "./job-store.js";
import { SavedSearchLimit } from "./saved-search-limit.js";
import type { TrackerFull } from "./tracker-full.js";
import { TrackerStore } from "./tracker.js";

export const listJobs = implement(listJobsContract, (query) =>
  Effect.gen(function* listJobsHandler() {
    const store = yield* JobStore;
    const generatedAt = yield* Clock.currentTimeMillis;
    const listing = yield* store.list(query, generatedAt);

    return { generatedAt, jobs: listing.jobs, total: listing.total };
  })
);

export const boardStats = implement(boardStatsContract, () =>
  Effect.gen(function* boardStatsHandler() {
    const store = yield* JobStore;
    const generatedAt = yield* Clock.currentTimeMillis;
    const stats = yield* store.stats(generatedAt);

    return { ...stats, generatedAt };
  })
);

export const getJob = implement(getJobContract, ({ id }) =>
  Effect.gen(function* getJobHandler() {
    const store = yield* JobStore;

    return yield* store.find(id);
  })
);

export const account = implement(accountContract, () => currentMember);

export const signInOptions = implement(signInOptionsContract, () =>
  AccountStore.use((store) => Effect.succeed(store.signInOptions))
);

export const saveSearch = implement(saveSearchContract, ({ filters }) =>
  Effect.gen(function* saveSearchHandler() {
    const member = yield* currentMember;
    const store = yield* AlertStore;

    const saved = yield* store.saveSearch(
      member.id,
      filters,
      yield* Clock.currentTimeMillis,
      MAX_SAVED_SEARCHES
    );

    return yield* Effect.fromOption(saved).pipe(
      Effect.mapError(() => new SavedSearchLimit({ limit: MAX_SAVED_SEARCHES }))
    );
  })
);

export const savedSearches = implement(savedSearchesContract, () =>
  Effect.gen(function* savedSearchesHandler() {
    const member = yield* currentMember;
    const store = yield* AlertStore;

    return yield* store.searchesOf(member.id);
  })
);

export const deleteSearch = implement(deleteSearchContract, ({ id }) =>
  Effect.gen(function* deleteSearchHandler() {
    const member = yield* currentMember;
    const store = yield* AlertStore;

    yield* store.deleteSearch(member.id, id);
  })
);

const changeTracker = <E extends JobStoreUnavailable | TrackerFull>(
  change: (
    store: TrackerStore["Service"],
    owner: AccountIdValue,
    now: number
  ) => EffectType.Effect<void, E>
) =>
  Effect.gen(function* changeTrackerHandler() {
    const { id } = yield* currentMember;
    const store = yield* TrackerStore;
    const now = yield* Clock.currentTimeMillis;

    yield* change(store, id, now);

    return yield* store.list(id);
  });

export const trackedJobs = implement(trackedJobsContract, () =>
  changeTracker(() => Effect.void)
);

export const trackJob = implement(trackJobContract, (job) =>
  changeTracker((store, owner, now) => store.track(owner, job, now))
);

export const importShortlist = implement(importShortlistContract, ({ jobs }) =>
  changeTracker((store, owner, now) => store.importMissing(owner, jobs, now))
);

export const noteTrackedJob = implement(
  noteTrackedJobContract,
  ({ jobId, notes }) =>
    changeTracker((store, owner) => store.note(owner, jobId, notes))
);

export const untrackJob = implement(untrackJobContract, ({ jobId }) =>
  changeTracker((store, owner) => store.untrack(owner, jobId))
);

export const capabilities = [
  listJobs,
  boardStats,
  getJob,
  account,
  signInOptions,
  saveSearch,
  savedSearches,
  deleteSearch,
  trackedJobs,
  trackJob,
  importShortlist,
  noteTrackedJob,
  untrackJob,
] as const;
