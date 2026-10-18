import { Option, Schema } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { JobQueries } from "../board/queries.js";
import { DeleteSearch, FetchSearches, SaveSearch } from "./command.js";
import { Message } from "./message.js";
import type { MessageValue, SaveOutcomeValue } from "./message.js";
import { SaveState, SearchesState } from "./model.js";
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
    save: SaveState.Idle(),
    searches: SearchesState.NotAsked(),
  },
});

export const entered = (model: ModelValue): UpdateReturn => ({
  commands: [FetchSearches()],
  model: Schema.is(SearchesState.Loaded)(model.searches)
    ? model
    : modifyFields(model, { searches: () => SearchesState.Loading() }),
});

export const filtersChanged = (model: ModelValue): ModelValue =>
  Schema.is(SaveState.Saving)(model.save)
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
            model: modifyFields(model, { save: () => SaveState.Saving() }),
          },
    CompletedDeleteSearch: ({ id, ok }) => ({
      model: modifyFields(model, {
        deleting: (ids) => ids.filter((pending) => pending !== id),
        searches: (state) =>
          ok && Schema.is(SearchesState.Loaded)(state)
            ? SearchesState.Loaded({
                searches: state.searches.filter((search) => search.id !== id),
              })
            : state,
      }),
    }),
    CompletedFetchSearches: ({ searches }) => ({
      model: modifyFields(model, {
        searches: () =>
          Option.match(searches, {
            onNone: () => SearchesState.Failed(),
            onSome: (found) => SearchesState.Loaded({ searches: found }),
          }),
      }),
    }),
    CompletedSaveSearch: ({ outcome }) => ({
      model: modifyFields(model, {
        save: () =>
          outcome === "Saved"
            ? SaveState.Saved()
            : SaveState.Failed({ message: failureText[outcome] }),
        searches: (state) =>
          outcome === "Saved" ? SearchesState.NotAsked() : state,
      }),
    }),
  });
