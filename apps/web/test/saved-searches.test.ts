import { describe, expect, it } from "@effect/vitest";
import { SavedSearch } from "@rat-stack/core/contracts";
import { Option, Schema } from "effect";
import { fromString } from "foldkit/url";

import { defaultFilters } from "../src/client/board/filters.js";
import { Message as BoardMessage } from "../src/client/board/message.js";
import { Preload } from "../src/client/board/model.js";
import {
  init as boardInit,
  update as boardUpdate,
} from "../src/client/board/update.js";
import { boardUrl, routeOfUrl, Route } from "../src/client/route.js";
import { Message } from "../src/client/saved-searches/message.js";
import {
  boardFiltersOf,
  SaveState,
  searchFiltersOf,
} from "../src/client/saved-searches/model.js";
import { init, update } from "../src/client/saved-searches/update.js";
import { edgeRouteOf } from "../src/edge-routes.js";
import {
  coverageNote,
  searchLabel,
} from "../src/features/saved-searches/view.js";

const saved = Schema.decodeSync(SavedSearch)({
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

const flags = { origin: "https://jobs.example", preload: Preload.Nothing() };

const urlAt = (path: string) =>
  Option.getOrThrow(fromString(`https://jobs.example${path}`));

describe("saved searches", () => {
  it("saves the board's roles, expanded places and search text", () => {
    const filters = Option.getOrThrow(
      searchFiltersOf({
        ...defaultFilters,
        regionGroups: ["RemoteCanada"],
        roles: ["Director"],
        search: " payments ",
      })
    );

    expect(filters).toEqual(saved.filters);
  });

  it("offers nothing to save when no role or place is picked", () => {
    expect(
      Option.isNone(searchFiltersOf({ ...defaultFilters, roles: [] }))
    ).toBe(true);
  });

  it("opens a saved search on the board with the filters it was saved from", () => {
    const route = routeOfUrl(urlAt(boardUrl(boardFiltersOf(saved))));

    expect(Schema.is(Route.Board)(route)).toBe(true);
    expect(Schema.is(Route.Board)(route) ? route.filters : undefined).toEqual({
      ...defaultFilters,
      regionGroups: ["RemoteCanada"],
      roles: ["Director"],
      search: "payments",
    });
    expect(searchLabel(saved)).toBe(
      'director, remote in Canada matching "payments"'
    );
  });

  it("names the covered sources without exposing term names", () => {
    expect(coverageNote()).toContain("only list roles from Jobicy");
    expect(coverageNote()).not.toMatch(/allowed|unstated|forbidden/iu);
  });

  it("sends one save request even when the button is pressed twice", () => {
    const first = update(
      init().model,
      Message.ClickedSaveSearch({ filters: saved.filters })
    );

    const second = update(
      first.model,
      Message.ClickedSaveSearch({ filters: saved.filters })
    );

    expect((first.commands ?? []).map((command) => command.name)).toEqual([
      "SaveSearch",
    ]);
    expect(second.commands ?? []).toEqual([]);
  });

  it("explains a refused save and lets the member try again after a filter change", () => {
    const refused = update(
      init().model,
      Message.CompletedSaveSearch({ outcome: "AtLimit" })
    ).model;

    expect(Schema.is(SaveState.Failed)(refused.save)).toBe(true);

    const board = boardInit(flags, urlAt("/")).model;

    const changed = boardUpdate(
      { ...board, savedSearches: refused },
      BoardMessage.ToggledRole({ role: "Director" })
    ).model;

    expect(Schema.is(SaveState.Idle)(changed.savedSearches.save)).toBe(true);
  });

  it("loads saved searches when the account page opens", () => {
    const step = boardInit(flags, urlAt("/account"));

    expect((step.commands ?? []).map((command) => command.name)).toContain(
      "FetchSearches"
    );
  });

  it("routes unsubscribe links to the backend, never the page cache", () => {
    expect(edgeRouteOf("/unsubscribe")).toBe("backend");
  });
});
