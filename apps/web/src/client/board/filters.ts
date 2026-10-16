import { Array, Match, pipe, Schema } from "effect";
import { JobQuery, RoleLevel } from "@rat-stack/core/contracts";
import type { RegionValue, RoleLevelValue } from "@rat-stack/core/contracts";

export const PAGE_SIZE = 40;

export const RegionGroup = Schema.Literals([
  "RemoteCanada",
  "RemoteUnitedStates",
  "BritishColumbia",
  "CanadaOnsite",
  "UnitedStatesOnsite",
  "Elsewhere",
]);

export type RegionGroup = typeof RegionGroup.Type;

export const regionGroups: ReadonlyArray<RegionGroup> = RegionGroup.literals;

export const regionsOfGroup = Match.type<RegionGroup>().pipe(
  Match.withReturnType<ReadonlyArray<RegionValue>>(),
  Match.when("RemoteCanada", () => ["RemoteCanada", "RemoteNorthAmerica", "RemoteGlobal"]),
  Match.when("RemoteUnitedStates", () => ["RemoteUnitedStates", "RemoteNorthAmerica", "RemoteGlobal"]),
  Match.when("BritishColumbia", () => ["BritishColumbia"]),
  Match.when("CanadaOnsite", () => ["CanadaOnsite"]),
  Match.when("UnitedStatesOnsite", () => ["UnitedStatesOnsite"]),
  Match.when("Elsewhere", () => ["Elsewhere"]),
  Match.exhaustive
);

export const AgeWindow = Schema.Literals([1, 3, 7, 14, 30]);

export type AgeWindow = typeof AgeWindow.Type;

export const ageWindows: ReadonlyArray<AgeWindow> = AgeWindow.literals;

export const Sort = Schema.Literals(["Relevance", "Newest"]);

export const Filters = Schema.Struct({
  maxAgeDays: AgeWindow,
  regionGroups: Schema.Array(RegionGroup),
  roles: Schema.Array(RoleLevel),
  search: Schema.String,
  sort: Sort,
});

export type Filters = typeof Filters.Type;

export const defaultFilters: Filters = {
  maxAgeDays: 7,
  regionGroups: ["RemoteCanada", "RemoteUnitedStates", "BritishColumbia"],
  roles: ["EngineeringManager", "Director", "HeadOfEngineering", "VicePresident"],
  search: "",
  sort: "Relevance",
};

export const toggled = <A>(values: ReadonlyArray<A>, value: A): ReadonlyArray<A> =>
  Array.contains(values, value)
    ? Array.filter(values, (current) => current !== value)
    : Array.append(values, value);

export const queryOf = (filters: Filters, offset: number): typeof JobQuery.Type => ({
  limit: PAGE_SIZE,
  maxAgeDays: filters.maxAgeDays,
  offset,
  regions: pipe(filters.regionGroups, Array.flatMap(regionsOfGroup), Array.dedupe),
  roles: filters.roles,
  search: filters.search.trim().slice(0, 80),
  sort: filters.sort,
});

export const hasNoSelection = (filters: Filters) =>
  Array.isReadonlyArrayEmpty(filters.roles) || Array.isReadonlyArrayEmpty(filters.regionGroups);

export type { RoleLevelValue };
