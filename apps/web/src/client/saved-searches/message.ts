import {
  SavedSearch,
  SavedSearchId,
  SearchFilters,
} from "@rat-stack/core/contracts";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

export const SaveOutcome = Schema.Literals([
  "Saved",
  "SignedOut",
  "AtLimit",
  "Failed",
]);

export type SaveOutcomeValue = typeof SaveOutcome.Type;

export const Message = defineMessageUnion({
  ClickedDeleteSearch: { id: SavedSearchId },
  ClickedSaveSearch: { filters: SearchFilters },
  CompletedDeleteSearch: { id: SavedSearchId, ok: Schema.Boolean },
  CompletedFetchSearches: {
    revision: Schema.Finite,
    searches: Schema.Option(Schema.Array(SavedSearch)),
  },
  CompletedSaveSearch: { filters: SearchFilters, outcome: SaveOutcome },
});

export type MessageValue = typeof Message.Type;
