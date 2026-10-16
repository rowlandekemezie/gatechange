import { JobQuery } from "@rat-stack/core/contracts";
import { Effect, Option, pipe, Predicate, Schema } from "effect";
import { Command } from "foldkit";

import { Message } from "./message.js";
import { Shortlist } from "./model.js";
import { JobQueries } from "./queries.js";

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

export const ReadShortlist = Command.define("ReadShortlist", {
  execute: Effect.sync(() => {
    try {
      return Option.fromNullishOr(window.localStorage.getItem(SHORTLIST_KEY));
    } catch {
      return Option.none<string>();
    }
  }).pipe(
    Effect.map((stored) =>
      Message.CompletedReadShortlist({
        marks: Option.getOrElse(
          pipe(stored, Option.flatMap(decodeShortlist)),
          () => []
        ),
      })
    )
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
