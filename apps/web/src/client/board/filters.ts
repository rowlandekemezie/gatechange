import { RoleLevel } from "@rat-stack/core/contracts";
import type { JobQueryValue, RegionValue } from "@rat-stack/core/contracts";
import { Array, Match, pipe, Schema } from "effect";

export const PAGE_SIZE = 40;

export const RegionGroup = Schema.Literals([
  "RemoteCanada",
  "RemoteUnitedStates",
  "BritishColumbia",
  "CanadaOnsite",
  "UnitedStatesOnsite",
  "Elsewhere",
]);

export type RegionGroupValue = typeof RegionGroup.Type;

export const regionGroups: readonly RegionGroupValue[] = RegionGroup.literals;

export const regionsOfGroup = Match.type<RegionGroupValue>().pipe(
  Match.withReturnType<readonly RegionValue[]>(),
  Match.when("RemoteCanada", () => [
    "RemoteCanada",
    "RemoteNorthAmerica",
    "RemoteGlobal",
  ]),
  Match.when("RemoteUnitedStates", () => [
    "RemoteUnitedStates",
    "RemoteNorthAmerica",
    "RemoteGlobal",
  ]),
  Match.when("BritishColumbia", () => ["BritishColumbia"]),
  Match.when("CanadaOnsite", () => ["CanadaOnsite"]),
  Match.when("UnitedStatesOnsite", () => ["UnitedStatesOnsite"]),
  Match.when("Elsewhere", () => ["Elsewhere"]),
  Match.exhaustive
);

export const AgeWindow = Schema.Literals([1, 3, 7, 14, 30]);

export type AgeWindowValue = typeof AgeWindow.Type;

export const ageWindows: readonly AgeWindowValue[] = AgeWindow.literals;

export const Sort = Schema.Literals(["Relevance", "Newest"]);

export const Filters = Schema.Struct({
  maxAgeDays: AgeWindow,
  regionGroups: Schema.Array(RegionGroup),
  roles: Schema.Array(RoleLevel),
  salaryListed: Schema.Boolean,
  search: Schema.String,
  sort: Sort,
});

export type FiltersValue = typeof Filters.Type;

export const defaultFilters: FiltersValue = {
  maxAgeDays: 7,
  regionGroups: ["RemoteCanada", "RemoteUnitedStates", "BritishColumbia"],
  roles: [
    "VicePresident",
    "HeadOfEngineering",
    "Director",
    "EngineeringManager",
  ],
  salaryListed: false,
  search: "",
  sort: "Relevance",
};

export const inOrderOf = <A>(
  universe: readonly A[],
  values: readonly A[]
): readonly A[] =>
  pipe(
    universe,
    Array.filter((candidate) => Array.contains(values, candidate))
  );

export const toggled = <A>(
  universe: readonly A[],
  values: readonly A[],
  value: A
): readonly A[] =>
  pipe(
    universe,
    Array.filter(
      (candidate) => (candidate === value) !== Array.contains(values, candidate)
    )
  );

export const queryOf = (
  filters: FiltersValue,
  offset: number
): JobQueryValue => ({
  limit: PAGE_SIZE,
  maxAgeDays: filters.maxAgeDays,
  offset,
  regions: pipe(
    filters.regionGroups,
    Array.flatMap(regionsOfGroup),
    Array.dedupe
  ),
  roles: filters.roles,
  salaryListed: filters.salaryListed,
  search: filters.search.trim().slice(0, 80),
  sort: filters.sort,
});

export const hasNoSelection = (filters: FiltersValue) =>
  Array.isReadonlyArrayEmpty(filters.roles) ||
  Array.isReadonlyArrayEmpty(filters.regionGroups);
