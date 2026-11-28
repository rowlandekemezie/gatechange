import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { Message } from "../src/client/board/message.js";
import { Message as SavedMessage } from "../src/client/saved-searches/message.js";
import type { MessageValue as SavedMessageValue } from "../src/client/saved-searches/message.js";
import {
  SaveState,
  SearchesState,
} from "../src/client/saved-searches/model.js";
import {
  leftTo,
  named,
  savedSearchOf,
  sentAll,
  signedIn,
  started,
  walked,
} from "./state-machines.support.js";

const saved = savedSearchOf({
  createdAt: 0,
  filters: {
    regions: ["RemoteCanada", "RemoteNorthAmerica", "RemoteGlobal"],
    roles: ["Director"],
    search: "payments",
  },
  frequency: "Weekly",
  id: "search-1",
  owner: "user_ada",
});

const ss = (message: SavedMessageValue) =>
  Message.GotSavedSearchesMessage({ message });

const listed = ss(
  SavedMessage.CompletedFetchSearches({
    revision: 0,
    searches: Option.some([saved]),
  })
);

const idsOf = (searches: typeof SearchesState.Type) =>
  Schema.is(SearchesState.Loaded)(searches)
    ? searches.searches.map((search) => search.id)
    : [];

describe("SavedSearches model replay", () => {
  it("DeletedStaysGone: a list read before the delete does not bring the deleted search back", () => {
    const revisit = walked(started("/account"), [
      signedIn,
      listed,
      leftTo("/"),
      leftTo("/account"),
    ]);

    expect(named(revisit.all, "FetchSearches").length).toBeGreaterThan(0);

    const done = sentAll(revisit.last, [
      ss(SavedMessage.ClickedDeleteSearch({ id: saved.id })),
      ss(SavedMessage.CompletedDeleteSearch({ id: saved.id, ok: true })),
      listed,
    ]);

    expect(idsOf(done.model.savedSearches.searches)).toStrictEqual([]);
  });

  it("SavedNoteIsTrue: changing filters while saving does not say Saved under the new filters", () => {
    const done = sentAll(started("/"), [
      signedIn,
      ss(SavedMessage.ClickedSaveSearch({ filters: saved.filters })),
      Message.ToggledRole({ role: "Director" }),
      ss(
        SavedMessage.CompletedSaveSearch({
          filters: saved.filters,
          outcome: "Saved",
        })
      ),
    ]);

    expect(done.model.savedSearches.save).not.toStrictEqual(SaveState.Saved());
  });

  it("holds CapHolds: a save past the limit says so and keeps the button", () => {
    const done = sentAll(started("/"), [
      signedIn,
      ss(SavedMessage.ClickedSaveSearch({ filters: saved.filters })),
      ss(
        SavedMessage.CompletedSaveSearch({
          filters: saved.filters,
          outcome: "AtLimit",
        })
      ),
    ]);

    expect(Schema.is(SaveState.Failed)(done.model.savedSearches.save)).toBe(
      true
    );
  });

  it("holds: a double tap on save sends one save", () => {
    const path = walked(started("/"), [
      signedIn,
      ss(SavedMessage.ClickedSaveSearch({ filters: saved.filters })),
      ss(SavedMessage.ClickedSaveSearch({ filters: saved.filters })),
    ]);

    expect(named(path.all, "SaveSearch")).toHaveLength(1);
  });

  it("holds DeletedStaysGone when the list was read after the delete", () => {
    const done = sentAll(started("/account"), [
      signedIn,
      listed,
      ss(SavedMessage.ClickedDeleteSearch({ id: saved.id })),
      ss(SavedMessage.CompletedDeleteSearch({ id: saved.id, ok: true })),
    ]);

    expect(idsOf(done.model.savedSearches.searches)).toStrictEqual([]);
  });
});
