import { SearchFilters } from "@rat-stack/core/contracts";
import type { SearchFiltersValue } from "@rat-stack/core/contracts";
import { Option, Schema } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { FiltersValue } from "../board/filters.js";
import type { JobQueries } from "../board/queries.js";
import { DeleteSearch, FetchSearches, SaveSearch } from "./command.js";
import { Message } from "./message.js";
import type { MessageValue, SaveOutcomeValue } from "./message.js";
import { SaveState, SearchesState, searchFiltersOf } from "./model.js";
import type { ModelValue } from "./model.js";

type UpdateReturn = Update.Return<ModelValue, MessageValue, JobQueries>;

const failureText: Record<Exclude<SaveOutcomeValue, "Saved">, string> = {
  AtLimit:
    "You already have the most saved searches we keep. Delete one on your account page first.",
  Failed: "We could not save this search. Try again in a minute.",
  SignedOut: "Sign in first, then save this search.",
};

export const init = (): UpdateReturn => ({
  model: {
    deleting: [],
    revision: 0,
    save: SaveState.Idle(),
    searches: SearchesState.NotAsked(),
  },
});

export const entered = (model: ModelValue): UpdateReturn => ({
  commands: [FetchSearches({ revision: model.revision })],
  model: Schema.is(SearchesState.Loaded)(model.searches)
    ? model
    : modifyFields(model, { searches: () => SearchesState.Loading() }),
});

const sameSearch = Schema.toEquivalence(SearchFilters);

const isSaving = (model: ModelValue, filters: SearchFiltersValue) =>
  Schema.is(SaveState.Saving)(model.save) &&
  sameSearch(model.save.filters, filters);

export const filtersChanged =
  (filters: FiltersValue) =>
  (model: ModelValue): ModelValue =>
    Option.exists(searchFiltersOf(filters), (next) => isSaving(model, next))
      ? model
      : modifyFields(model, { save: () => SaveState.Idle() });

export const update = (
  model: ModelValue,
  message: MessageValue
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedDeleteSearch: ({ id }) => ({
      commands: [DeleteSearch({ id })],
      model: modifyFields(model, { deleting: (ids) => [...ids, id] }),
    }),
    ClickedSaveSearch: ({ filters }) =>
      Schema.is(SaveState.Saving)(model.save)
        ? { model }
        : {
            commands: [SaveSearch({ filters })],
            model: modifyFields(model, {
              save: () => SaveState.Saving({ filters }),
            }),
          },
    CompletedDeleteSearch: ({ id, ok }) => ({
      model: modifyFields(model, {
        deleting: (ids) => ids.filter((pending) => pending !== id),
        revision: (revision) => (ok ? revision + 1 : revision),
        searches: (state) =>
          ok && Schema.is(SearchesState.Loaded)(state)
            ? SearchesState.Loaded({
                searches: state.searches.filter((search) => search.id !== id),
              })
            : state,
      }),
    }),
    CompletedFetchSearches: ({ revision, searches }) =>
      revision === model.revision
        ? {
            model: modifyFields(model, {
              searches: () =>
                Option.match(searches, {
                  onNone: () => SearchesState.Failed(),
                  onSome: (found) => SearchesState.Loaded({ searches: found }),
                }),
            }),
          }
        : { commands: [FetchSearches({ revision: model.revision })], model },
    CompletedSaveSearch: ({ filters, outcome }) => ({
      model: modifyFields(model, {
        revision: (revision) => (outcome === "Saved" ? revision + 1 : revision),
        save: (save) => {
          if (!isSaving(model, filters)) {
            return save;
          }

          return outcome === "Saved"
            ? SaveState.Saved()
            : SaveState.Failed({ message: failureText[outcome] });
        },
        searches: (state) =>
          outcome === "Saved" ? SearchesState.NotAsked() : state,
      }),
    }),
  });
