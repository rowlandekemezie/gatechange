import { roleLevels } from "@rat-stack/core/contracts";
import {
  Array,
  Effect,
  Equivalence,
  Option,
  pipe,
  Result,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import type { Types } from "effect";
import { Base64Url } from "effect/encoding";
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
import type { Url } from "foldkit/url";

import {
  ageWindows,
  defaultFilters,
  Filters,
  inOrderOf,
  regionGroups,
  Sort,
} from "./board/filters.js";
import type { FiltersValue } from "./board/filters.js";

export const AccountNotice = Schema.Literals([
  "None",
  "LinkRefused",
  "SignInFailed",
]);

export type AccountNoticeValue = typeof AccountNotice.Type;

export const Route = defineRouteUnion({
  Account: { notice: AccountNotice },
  Board: { filters: Filters },
  ConfirmSignIn: { token: Schema.String },
  Job: { id: Schema.NonEmptyString },
  NotFound: {},
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

  const parsed = inOrderOf(
    values,
    Array.getSomes(pipe(raw.split(","), Array.map(fromSlug(values))))
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

const idOfSegment = (segment: string) =>
  pipe(
    Result.getSuccess(Base64Url.decodeString(segment)),
    Option.filter((id) => Base64Url.encode(id) === segment)
  );

const JobIdSegment = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString,
    SchemaTransformation.transformEffect({
      decode: (segment, options) =>
        Effect.fromOption(idOfSegment(segment)).pipe(
          Effect.mapError(
            () =>
              new SchemaIssue.InvalidValue(
                { expected: "a canonical unpadded base64url job id" },
                segment,
                options
              )
          )
        ),
      encode: (id) => Effect.succeed(Base64Url.encode(id)),
    })
  )
);

export const boardRouter = pipe(root, query(BoardParams), mapTo(Route.Board));

const refusedLinkErrors = new Set([
  "INVALID_TOKEN",
  "EXPIRED_TOKEN",
  "ATTEMPTS_EXCEEDED",
]);

const noticeOfError = (error: string | undefined): AccountNoticeValue => {
  if (error === undefined) {
    return "None";
  }

  return refusedLinkErrors.has(error) ? "LinkRefused" : "SignInFailed";
};

const errorOfNotice = {
  LinkRefused: { error: "INVALID_TOKEN" },
  None: {},
  SignInFailed: { error: "SIGN_IN_FAILED" },
} as const;

const AccountParams = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({ notice: AccountNotice }),
    SchemaTransformation.transform({
      decode: ({ error }) => ({ notice: noticeOfError(error) }),
      encode: ({ notice }) => errorOfNotice[notice],
    })
  )
);

export const accountRouter = pipe(
  literal("account"),
  query(AccountParams),
  mapTo(Route.Account)
);

export const confirmSignInRouter = pipe(
  literal("account"),
  slash(literal("confirm")),
  query(Schema.Struct({ token: Schema.String })),
  mapTo(Route.ConfirmSignIn)
);

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
  oneOf(
    jobRouter,
    shortlistRouter,
    confirmSignInRouter,
    accountRouter,
    boardRouter
  ),
  { make: () => Route.NotFound() }
);

export const boardUrl = (filters: FiltersValue) => boardRouter({ filters });

export const addressOf = (url: Url) =>
  Option.match(url.search, {
    onNone: () => url.pathname,
    onSome: (search) => `${url.pathname}?${search}`,
  });
