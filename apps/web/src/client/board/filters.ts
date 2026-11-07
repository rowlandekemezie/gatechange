import {
  Currency,
  RegionGroup,
  regionsOfSelection,
  RoleLevel,
  Seniority,
} from "@rat-stack/core/contracts";
import type { CurrencyValue, JobQueryValue } from "@rat-stack/core/contracts";
import { Array, pipe, Schema } from "effect";

export const FIRST_PAGE_SIZE = 15;

export const MORE_PAGE_SIZE = 25;

export const AgeWindow = Schema.Literals([1, 3, 7, 14, 30, 3650]);

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
  limit: offset === 0 ? FIRST_PAGE_SIZE : MORE_PAGE_SIZE,
  maxAgeDays: filters.maxAgeDays,
  offset,
  regions: regionsOfSelection(filters.regionGroups),
  roles: filters.roles,
  salaryFloor: filters.salaryFloor,
  salaryListed: filters.salaryListed,
  search: filters.search.trim().slice(0, 80),
  seniorities: filters.seniorities,
  sort: filters.sort,
});

export const hasProSelection = (filters: FiltersValue) =>
  filters.salaryListed ||
  filters.salaryFloor !== null ||
  filters.seniorities.length > 0;

export const hasNoSelection = (filters: FiltersValue) =>
  Array.isReadonlyArrayEmpty(filters.roles) ||
  Array.isReadonlyArrayEmpty(filters.regionGroups);
