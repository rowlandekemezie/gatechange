import { JobQuery, MAX_IMPORTED_JOBS } from "@rat-stack/core/contracts";
import { Array, Effect, Option, pipe, Predicate, Schema } from "effect";
import { Command } from "foldkit";
import { load, pushUrl, replaceUrl } from "foldkit/navigation";

import { collectListing, ListingRoute } from "../listing.js";
import { Message } from "./message.js";
import { Shortlist, TrackerChange } from "./model.js";
import type { MarkedJobValue } from "./model.js";
import { JobQueries } from "./queries.js";
import { importRequestsOf } from "./tracker.js";

const SHORTLIST_KEY = "jobs.shortlist.v1";

const failureText = (failure: { readonly _tag: string }) =>
  Predicate.isTagged(failure, "JobStoreUnavailable")
    ? "The job list is unavailable right now. It usually comes back within a few minutes."
    : "Could not reach the job list. Check your connection, then try again.";

export const FetchJobs = Command.define("FetchJobs", {
  args: { generation: Schema.Finite, query: JobQuery },
  execute: ({ generation, query }) =>
    JobQueries.use((queries) => queries.listJobs(query)).pipe(
      Effect.match({
        onFailure: (failure) =>
          Message.FailedFetchJobs({
            generation,
            message: failureText(failure),
          }),
        onSuccess: (page) => Message.SucceededFetchJobs({ generation, page }),
      })
    ),
  messages: [Message.SucceededFetchJobs, Message.FailedFetchJobs],
});

export const FetchJob = Command.define("FetchJob", {
  args: { id: Schema.String },
  execute: ({ id }) =>
    JobQueries.use((queries) => queries.getJob(id)).pipe(
      Effect.match({
        onFailure: (failure) =>
          Message.FailedFetchJob({ id, message: failureText(failure) }),
        onSuccess: (job) => Message.SucceededFetchJob({ id, job }),
      })
    ),
  messages: [Message.SucceededFetchJob, Message.FailedFetchJob],
});

export const FetchListing = Command.define("FetchListing", {
  args: { route: ListingRoute },
  execute: ({ route }) =>
    JobQueries.use((queries) => collectListing(queries.listJobs, route)).pipe(
      Effect.match({
        onFailure: (failure) =>
          Message.FailedFetchListing({ message: failureText(failure), route }),
        onSuccess: (listing) =>
          Message.SucceededFetchListing({ listing, route }),
      })
    ),
  messages: [Message.SucceededFetchListing, Message.FailedFetchListing],
});

export const PushUrl = Command.define("PushUrl", {
  args: { url: Schema.String },
  execute: ({ url }) =>
    pushUrl(url).pipe(Effect.as(Message.CompletedNavigation())),
  messages: [Message.CompletedNavigation],
});

export const ReplaceUrl = Command.define("ReplaceUrl", {
  args: { url: Schema.String },
  execute: ({ url }) =>
    replaceUrl(url).pipe(Effect.as(Message.CompletedNavigation())),
  messages: [Message.CompletedNavigation],
});

export const LoadUrl = Command.define("LoadUrl", {
  args: { href: Schema.String },
  execute: ({ href }) =>
    load(href).pipe(Effect.as(Message.CompletedNavigation())),
  messages: [Message.CompletedNavigation],
});

export const FetchMoreJobs = Command.define("FetchMoreJobs", {
  args: { generation: Schema.Finite, query: JobQuery },
  execute: ({ generation, query }) =>
    JobQueries.use((queries) => queries.listJobs(query)).pipe(
      Effect.match({
        onFailure: () => Message.FailedFetchMoreJobs({ generation }),
        onSuccess: (page) =>
          Message.SucceededFetchMoreJobs({ generation, page }),
      })
    ),
  messages: [Message.SucceededFetchMoreJobs, Message.FailedFetchMoreJobs],
});

export const FetchStats = Command.define("FetchStats", {
  execute: JobQueries.use((queries) => queries.stats).pipe(
    Effect.match({
      onFailure: () => Message.FailedFetchStats(),
      onSuccess: (stats) => Message.SucceededFetchStats({ stats }),
    })
  ),
  messages: [Message.SucceededFetchStats, Message.FailedFetchStats],
});

const decodeShortlist = Schema.decodeUnknownOption(
  Schema.fromJsonString(Shortlist)
);

const storedShortlist = (): readonly MarkedJobValue[] => {
  try {
    return Option.getOrElse(
      pipe(
        Option.fromNullishOr(window.localStorage.getItem(SHORTLIST_KEY)),
        Option.flatMap(decodeShortlist)
      ),
      () => []
    );
  } catch {
    return [];
  }
};

const forgetStoredShortlist = Effect.try(() => {
  window.localStorage.removeItem(SHORTLIST_KEY);
}).pipe(Effect.ignore);

export const ReadShortlist = Command.define("ReadShortlist", {
  execute: Effect.sync(() =>
    Message.CompletedReadShortlist({ marks: storedShortlist() })
  ),
  messages: [Message.CompletedReadShortlist],
});

export const WriteShortlist = Command.define("WriteShortlist", {
  args: { marks: Shortlist },
  execute: ({ marks }) =>
    Effect.sync(() => {
      try {
        window.localStorage.setItem(SHORTLIST_KEY, JSON.stringify(marks));
      } catch {
        return Message.CompletedWriteShortlist();
      }

      return Message.CompletedWriteShortlist();
    }),
  messages: [Message.CompletedWriteShortlist],
});

const trackerFailureText = (failure: { readonly _tag: string }) => {
  if (Predicate.isTagged(failure, "Unauthorized")) {
    return "Your session ended. Sign in again to keep tracking.";
  }

  return Predicate.isTagged(failure, "JobStoreUnavailable")
    ? "Your tracker is unavailable right now. Try again in a minute."
    : "Could not reach your tracker. Check your connection, then try again.";
};

export const SyncTracker = Command.define("SyncTracker", {
  args: { revision: Schema.Finite },
  execute: ({ revision }) =>
    JobQueries.use((queries) =>
      Effect.gen(function* syncTracker() {
        const requests = importRequestsOf(storedShortlist());

        if (!Array.isReadonlyArrayNonEmpty(requests)) {
          return yield* queries.trackedJobs;
        }

        const imported = yield* Effect.forEach(
          Array.chunksOf(requests, MAX_IMPORTED_JOBS),
          queries.importShortlist
        );

        yield* forgetStoredShortlist;

        return Array.lastNonEmpty(imported);
      })
    ).pipe(
      Effect.match({
        onFailure: (failure) =>
          Message.FailedSyncTracker({
            message: trackerFailureText(failure),
            revision,
          }),
        onSuccess: (jobs) => Message.CompletedSyncTracker({ jobs, revision }),
      })
    ),
  messages: [Message.CompletedSyncTracker, Message.FailedSyncTracker],
});

export const SendTrackerChange = Command.define("SendTrackerChange", {
  args: { change: TrackerChange, revision: Schema.Finite },
  execute: ({ change, revision }) =>
    JobQueries.use((queries) =>
      TrackerChange.match(change, {
        Note: ({ jobId, notes }) => queries.noteTrackedJob(jobId, notes),
        Track: ({ job }) => queries.trackJob(job),
        Untrack: ({ jobId }) => queries.untrackJob(jobId),
      })
    ).pipe(
      Effect.match({
        onFailure: (failure) =>
          Message.FailedTrackerChange({
            message: trackerFailureText(failure),
            revision,
          }),
        onSuccess: (jobs) => Message.SucceededTrackerChange({ jobs, revision }),
      })
    ),
  messages: [Message.SucceededTrackerChange, Message.FailedTrackerChange],
});
