import { Currency, RoleLevel, Seniority } from "@rat-stack/core/contracts";
import type {
  CurrencyValue,
  JobQueryValue,
  RegionValue,
} from "@rat-stack/core/contracts";
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

export const SalaryStep = Schema.Literals([
  150_000, 200_000, 250_000, 300_000, 400_000,
]);

export type SalaryStepValue = typeof SalaryStep.Type;

export const salarySteps: readonly SalaryStepValue[] = SalaryStep.literals;

export const PayFloor = Schema.Struct({
  amount: SalaryStep,
  currency: Currency,
});

export type PayFloorValue = typeof PayFloor.Type;

export const DEFAULT_PAY_CURRENCY: CurrencyValue = "USD";

export const Filters = Schema.Struct({
  maxAgeDays: AgeWindow,
  regionGroups: Schema.Array(RegionGroup),
  roles: Schema.Array(RoleLevel),
  salaryFloor: Schema.NullOr(PayFloor),
  salaryListed: Schema.Boolean,
  search: Schema.String,
  seniorities: Schema.Array(Seniority),
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
  salaryFloor: null,
  salaryListed: false,
  search: "",
  seniorities: [],
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
  salaryFloor: filters.salaryFloor,
  salaryListed: filters.salaryListed,
  search: filters.search.trim().slice(0, 80),
  seniorities: filters.seniorities,
  sort: filters.sort,
});

export const hasNoSelection = (filters: FiltersValue) =>
  Array.isReadonlyArrayEmpty(filters.roles) ||
  Array.isReadonlyArrayEmpty(filters.regionGroups);
