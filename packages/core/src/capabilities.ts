import { implement } from "@rat-stack/capability/implement";
import { Clock, Effect, Option } from "effect";
import type { Effect as EffectType } from "effect";

import { AccountStore } from "./account-store.js";
import { CurrentViewer, currentMember, Viewer } from "./account.js";
import type { AccountIdValue, AccountValue } from "./account.js";
import { AlertStore } from "./alert-store.js";
import { MAX_SAVED_SEARCHES } from "./alerts.js";
import { AlreadyPro } from "./already-pro.js";
import { BillingStore } from "./billing-store.js";
import { Billing, entitlementOfAccount } from "./billing.js";
import { companyIntelOf } from "./company-intel.js";
import {
  accountContract,
  boardStatsContract,
  companyIntelContract,
  companyJobsContract,
  deleteSearchContract,
  getJobContract,
  importShortlistContract,
  listJobsContract,
  membershipContract,
  openBillingPortalContract,
  savedSearchesContract,
  saveSearchContract,
  noteTrackedJobContract,
  setInstantAlertsContract,
  signInOptionsContract,
  startCheckoutContract,
  trackedJobsContract,
  trackJobContract,
  untrackJobContract,
} from "./contracts.js";
import { isPro, proFiltersCleared, usesProFilters } from "./entitlement.js";
import type { JobStoreUnavailable } from "./job-store-unavailable.js";
import { JobStore } from "./job-store.js";
import type { JobQueryValue } from "./job.js";
import { NoBillingAccount } from "./no-billing-account.js";
import { ProRequired } from "./pro-required.js";
import { SavedSearchLimit } from "./saved-search-limit.js";
import type { TrackerFull } from "./tracker-full.js";
import { TrackerStore } from "./tracker.js";

const viewerIsPro = CurrentViewer.pipe(
  Effect.flatMap((viewer) =>
    Viewer.$match(viewer, {
      Anonymous: () => Effect.succeed(false),
      Member: ({ account: member }) =>
        entitlementOfAccount(member.id).pipe(Effect.map(isPro)),
    })
  )
);

const servedQuery = (query: JobQueryValue) =>
  usesProFilters(query)
    ? viewerIsPro.pipe(
        Effect.map((pro) => (pro ? query : proFiltersCleared(query)))
      )
    : Effect.succeed(query);

export const listJobs = implement(listJobsContract, (query) =>
  Effect.gen(function* listJobsHandler() {
    const store = yield* JobStore;
    const served = yield* servedQuery(query);
    const generatedAt = yield* Clock.currentTimeMillis;
    const listing = yield* store.list(served, generatedAt);

    return { generatedAt, jobs: listing.jobs, total: listing.total };
  })
);

export const companyJobs = implement(companyJobsContract, ({ slug }) =>
  Effect.gen(function* companyJobsHandler() {
    const store = yield* JobStore;
    const generatedAt = yield* Clock.currentTimeMillis;
    const listing = yield* store.companyJobs(slug, generatedAt);

    return { ...listing, generatedAt };
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

const membershipOf = (owner: AccountIdValue) =>
  Effect.all({
    entitlement: entitlementOfAccount(owner),
    instantAlerts: AlertStore.use((store) => store.instantAlertsOf(owner)),
  });

export const membership = implement(membershipContract, () =>
  currentMember.pipe(Effect.flatMap(({ id }) => membershipOf(id)))
);

const billingCustomerOf = Effect.fn("billingCustomerOf")(
  function* billingCustomerOf(member: AccountValue) {
    const store = yield* BillingStore;
    const linked = yield* store.customerOf(member.id);

    if (Option.isSome(linked)) {
      return linked.value;
    }

    const created = yield* Billing.use((billing) =>
      billing.createCustomer(member)
    );

    yield* store.linkCustomer(
      member.id,
      created,
      yield* Clock.currentTimeMillis
    );

    return Option.getOrElse(yield* store.customerOf(member.id), () => created);
  }
);

export const startCheckout = implement(startCheckoutContract, ({ plan }) =>
  Effect.gen(function* startCheckoutHandler() {
    const member = yield* currentMember;

    if (isPro(yield* entitlementOfAccount(member.id))) {
      return yield* new AlreadyPro();
    }

    const customer = yield* billingCustomerOf(member);

    const url = yield* Billing.use((billing) =>
      billing.checkout({ account: member, customer, plan })
    );

    return { url };
  })
);

export const openBillingPortal = implement(openBillingPortalContract, () =>
  Effect.gen(function* openBillingPortalHandler() {
    const member = yield* currentMember;

    const customer = yield* BillingStore.use((store) =>
      store.customerOf(member.id)
    );

    if (Option.isNone(customer)) {
      return yield* new NoBillingAccount();
    }

    const url = yield* Billing.use((billing) => billing.portal(customer.value));

    return { url };
  })
);

export const setInstantAlerts = implement(
  setInstantAlertsContract,
  ({ enabled }) =>
    Effect.gen(function* setInstantAlertsHandler() {
      const member = yield* currentMember;

      if (enabled && !isPro(yield* entitlementOfAccount(member.id))) {
        return yield* new ProRequired();
      }

      const now = yield* Clock.currentTimeMillis;

      yield* AlertStore.use((store) =>
        store.setInstantAlerts(member.id, enabled, now)
      );

      return yield* membershipOf(member.id);
    })
);

export const companyIntel = implement(companyIntelContract, ({ slug }) =>
  Effect.gen(function* companyIntelHandler() {
    const member = yield* currentMember;

    if (!isPro(yield* entitlementOfAccount(member.id))) {
      return yield* new ProRequired();
    }

    const now = yield* Clock.currentTimeMillis;

    const records = yield* JobStore.use((store) =>
      store.companyRecords(slug, now)
    );

    return companyIntelOf(slug, records, now);
  })
);

export const capabilities = [
  listJobs,
  companyJobs,
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
  membership,
  startCheckout,
  openBillingPortal,
  setInstantAlerts,
  companyIntel,
] as const;
