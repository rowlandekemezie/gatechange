import { SavedSearchId, SearchFilters } from "@rat-stack/core/contracts";
import { Effect, Option, Predicate, Schema } from "effect";
import { Command } from "foldkit";

import { JobQueries } from "../board/queries.js";
import { Message } from "./message.js";
import type { SaveOutcomeValue } from "./message.js";

const outcomeOf = (failure: { readonly _tag: string }): SaveOutcomeValue => {
  if (Predicate.isTagged(failure, "Unauthorized")) {
    return "SignedOut";
  }

  return Predicate.isTagged(failure, "SavedSearchLimit") ? "AtLimit" : "Failed";
};

export const FetchSearches = Command.define("FetchSearches", {
  args: { revision: Schema.Finite },
  execute: ({ revision }) =>
    JobQueries.use((queries) => queries.savedSearches).pipe(
      Effect.match({
        onFailure: () =>
          Message.CompletedFetchSearches({ revision, searches: Option.none() }),
        onSuccess: (searches) =>
          Message.CompletedFetchSearches({
            revision,
            searches: Option.some(searches),
          }),
      })
    ),
  messages: [Message.CompletedFetchSearches],
});

export const SaveSearch = Command.define("SaveSearch", {
  args: { filters: SearchFilters },
  execute: ({ filters }) =>
    JobQueries.use((queries) => queries.saveSearch(filters)).pipe(
      Effect.match({
        onFailure: (failure) =>
          Message.CompletedSaveSearch({ filters, outcome: outcomeOf(failure) }),
        onSuccess: () =>
          Message.CompletedSaveSearch({ filters, outcome: "Saved" }),
      })
    ),
  messages: [Message.CompletedSaveSearch],
});

export const DeleteSearch = Command.define("DeleteSearch", {
  args: { id: SavedSearchId },
  execute: ({ id }) =>
    JobQueries.use((queries) => queries.deleteSearch(id)).pipe(
      Effect.match({
        onFailure: () => Message.CompletedDeleteSearch({ id, ok: false }),
        onSuccess: () => Message.CompletedDeleteSearch({ id, ok: true }),
      })
    ),
  messages: [Message.CompletedDeleteSearch],
});
