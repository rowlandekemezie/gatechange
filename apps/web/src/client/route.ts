import { roleLevels } from "@rat-stack/core/contracts";
import {
  Array,
  Equivalence,
  Option,
  pipe,
  Schema,
  SchemaTransformation,
} from "effect";
import type { Types } from "effect";
import {
  defineRouteUnion,
  literal,
  mapTo,
  oneOf,
  parseUrlWithFallback,
  query,
  root,
  schemaSegment,
  slash,
} from "foldkit/route";

import {
  ageWindows,
  defaultFilters,
  Filters,
  regionGroups,
  Sort,
} from "./board/filters.js";
import type { FiltersValue } from "./board/filters.js";

export const Route = defineRouteUnion({
  Board: { filters: Filters },
  Job: { id: Schema.NonEmptyString },
  NotFound: { path: Schema.String },
  Shortlist: {},
});

export type RouteValue = typeof Route.Type;

const slugOf = (value: string | number) =>
  String(value)
    .replaceAll(/(?<=[a-z])(?=[A-Z])/gu, "-")
    .toLowerCase();

const fromSlug =
  <A extends string | number>(values: readonly A[]) =>
  (slug: string): Option.Option<A> =>
    Array.findFirst(values, (value) => slugOf(value) === slug);

const listParam = <A extends string | number>(
  values: readonly A[],
  fallback: readonly A[],
  raw: string | undefined
): readonly A[] => {
  if (raw === undefined) {
    return fallback;
  }

  if (raw === "") {
    return [];
  }

  const parsed = Array.getSomes(
    pipe(raw.split(","), Array.map(fromSlug(values)))
  );

  return Array.isReadonlyArrayEmpty(parsed) ? fallback : parsed;
};

const oneParam = <A extends string | number>(
  values: readonly A[],
  fallback: A,
  raw: string | undefined
): A =>
  raw === undefined
    ? fallback
    : Option.getOrElse(fromSlug(values)(raw), () => fallback);

const BoardQuery = Schema.Struct({
  age: Schema.optionalKey(Schema.String),
  place: Schema.optionalKey(Schema.String),
  q: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  sort: Schema.optionalKey(Schema.String),
});

type BoardQueryValue = typeof BoardQuery.Type;

const sameList = <A>(left: readonly A[], right: readonly A[]) =>
  Array.makeEquivalence(Equivalence.strictEqual<A>())(left, right);

const filtersOfQuery = (params: BoardQueryValue): FiltersValue => ({
  maxAgeDays: oneParam(ageWindows, defaultFilters.maxAgeDays, params.age),
  regionGroups: listParam(
    regionGroups,
    defaultFilters.regionGroups,
    params.place
  ),
  roles: listParam(roleLevels, defaultFilters.roles, params.role),
  search: params.q ?? defaultFilters.search,
  sort: oneParam(Sort.literals, defaultFilters.sort, params.sort),
});

const queryOfFilters = (filters: FiltersValue): BoardQueryValue => {
  const params: Types.Mutable<BoardQueryValue> = {};

  if (filters.maxAgeDays !== defaultFilters.maxAgeDays) {
    params.age = slugOf(filters.maxAgeDays);
  }

  if (!sameList(filters.regionGroups, defaultFilters.regionGroups)) {
    params.place = filters.regionGroups.map(slugOf).join(",");
  }

  if (filters.search !== defaultFilters.search) {
    params.q = filters.search;
  }

  if (!sameList(filters.roles, defaultFilters.roles)) {
    params.role = filters.roles.map(slugOf).join(",");
  }

  if (filters.sort !== defaultFilters.sort) {
    params.sort = slugOf(filters.sort);
  }

  return params;
};

const BoardParams = BoardQuery.pipe(
  Schema.decodeTo(
    Schema.Struct({ filters: Filters }),
    SchemaTransformation.transform({
      decode: (params) => ({ filters: filtersOfQuery(params) }),
      encode: ({ filters }) => queryOfFilters(filters),
    })
  )
);

const JobIdSegment = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString,
    SchemaTransformation.stringFromUriComponent
  )
);

export const boardRouter = pipe(root, query(BoardParams), mapTo(Route.Board));

export const shortlistRouter = pipe(
  literal("shortlist"),
  mapTo(Route.Shortlist)
);

export const jobRouter = pipe(
  literal("jobs"),
  slash(schemaSegment("id", JobIdSegment)),
  mapTo(Route.Job)
);

export const routeOfUrl = parseUrlWithFallback(
  oneOf(jobRouter, shortlistRouter, boardRouter),
  Route.NotFound
);

export const boardUrl = (filters: FiltersValue) => boardRouter({ filters });
