import { regionGroups, SavedSearch } from "@rat-stack/core/contracts";
import { Array, Option, pipe, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { defaultFilters, queryOf } from "../board/filters.js";
import type { FiltersValue } from "../board/filters.js";

export const SearchesState = defineTaggedUnion({
  Failed: {},
  Loaded: { searches: Schema.Array(SavedSearch) },
  Loading: {},
  NotAsked: {},
});

export const SaveState = defineTaggedUnion({
  Failed: { message: Schema.String },
  Idle: {},
  Saved: {},
  Saving: {},
});

export type SaveStateValue = typeof SaveState.Type;

export const Model = Schema.Struct({
  deleting: Schema.Array(Schema.String),
  save: SaveState,
  searches: SearchesState,
});

export type ModelValue = typeof Model.Type;

export const searchFiltersOf = (filters: FiltersValue) => {
  const { regions, roles, search } = queryOf(filters, 0);

  return Array.isReadonlyArrayNonEmpty(regions) &&
    Array.isReadonlyArrayNonEmpty(roles)
    ? Option.some({ regions, roles, search })
    : Option.none();
};

export const boardFiltersOf = (
  saved: typeof SavedSearch.Type
): FiltersValue => ({
  ...defaultFilters,
  regionGroups: pipe(
    regionGroups,
    Array.filter((group) => Array.contains(saved.filters.regions, group))
  ),
  roles: saved.filters.roles,
  search: saved.filters.search,
});
