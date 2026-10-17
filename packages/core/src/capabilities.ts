import { implement } from "@rat-stack/capability/implement";
import { Clock, Effect } from "effect";

import {
  boardStatsContract,
  getJobContract,
  listJobsContract,
} from "./contracts.js";
import { JobStore } from "./job-store.js";

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

export const capabilities = [listJobs, boardStats, getJob] as const;
