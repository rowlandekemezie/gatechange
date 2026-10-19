import { RoleLevel, roleLevels } from "@rat-stack/core/contracts";
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
  RegionGroup,
  regionGroups,
  Sort,
} from "./board/filters.js";
import type { FiltersValue } from "./board/filters.js";

export const AccountNotice = Schema.Literals([
  "None",
  "LinkRefused",
  "SignInFailed",
  "CheckoutDone",
]);

export type AccountNoticeValue = typeof AccountNotice.Type;

export const CompanySlug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
);

export const Route = defineRouteUnion({
  Account: { notice: AccountNotice },
  Board: { filters: Filters },
  Company: { slug: CompanySlug },
  ConfirmSignIn: { token: Schema.String },
  Job: { id: Schema.NonEmptyString },
  NotFound: {},
  Pricing: {},
  Role: { place: RegionGroup, role: RoleLevel },
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

const slugSegment = <A extends string>(
  values: readonly A[],
  expected: string
) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Literals(values),
      SchemaTransformation.transformEffect({
        decode: (segment, options) =>
          Effect.fromOption(fromSlug(values)(segment)).pipe(
            Effect.mapError(
              () => new SchemaIssue.InvalidValue({ expected }, segment, options)
            )
          ),
        encode: (value) => Effect.succeed(slugOf(value)),
      })
    )
  );

export const companySlugOf = (company: string): Option.Option<string> =>
  Option.liftPredicate(
    company
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word.length > 0)
      .join("-"),
    (slug) => slug.length > 0
  );

const SALARY_LISTED = "listed";

const CHECKOUT_DONE = "done";

const BoardQuery = Schema.Struct({
  age: Schema.optionalKey(Schema.String),
  place: Schema.optionalKey(Schema.String),
  q: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  salary: Schema.optionalKey(Schema.String),
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
  salaryListed: params.salary === SALARY_LISTED,
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

  if (filters.salaryListed) {
    params.salary = SALARY_LISTED;
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

const noticeOfParams = ({
  checkout,
  error,
}: {
  readonly checkout?: string;
  readonly error?: string;
}): AccountNoticeValue => {
  if (error !== undefined) {
    return refusedLinkErrors.has(error) ? "LinkRefused" : "SignInFailed";
  }

  return checkout === CHECKOUT_DONE ? "CheckoutDone" : "None";
};

const paramsOfNotice = {
  CheckoutDone: { checkout: CHECKOUT_DONE },
  LinkRefused: { error: "INVALID_TOKEN" },
  None: {},
  SignInFailed: { error: "SIGN_IN_FAILED" },
} as const;

const AccountParams = Schema.Struct({
  checkout: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({ notice: AccountNotice }),
    SchemaTransformation.transform({
      decode: (params) => ({ notice: noticeOfParams(params) }),
      encode: ({ notice }) => paramsOfNotice[notice],
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

export const pricingRouter = pipe(literal("pricing"), mapTo(Route.Pricing));

export const shortlistRouter = pipe(
  literal("shortlist"),
  mapTo(Route.Shortlist)
);

export const jobRouter = pipe(
  literal("jobs"),
  slash(schemaSegment("id", JobIdSegment)),
  mapTo(Route.Job)
);

export const companyRouter = pipe(
  literal("companies"),
  slash(schemaSegment("slug", CompanySlug)),
  mapTo(Route.Company)
);

export const roleRouter = pipe(
  literal("roles"),
  slash(schemaSegment("role", slugSegment(roleLevels, "a role level slug"))),
  slash(schemaSegment("place", slugSegment(regionGroups, "a place slug"))),
  mapTo(Route.Role)
);

export const routeOfUrl = parseUrlWithFallback(
  oneOf(
    jobRouter,
    companyRouter,
    roleRouter,
    pricingRouter,
    shortlistRouter,
    confirmSignInRouter,
    accountRouter,
    boardRouter
  ),
  { make: () => Route.NotFound() }
);

export const boardUrl = (filters: FiltersValue) => boardRouter({ filters });

export const canonicalPathOf = (route: RouteValue) =>
  Route.match<Option.Option<string>>(route, {
    Account: () => Option.none(),
    Board: ({ filters }) => Option.some(boardUrl(filters)),
    Company: ({ slug }) => Option.some(companyRouter({ slug })),
    ConfirmSignIn: () => Option.none(),
    Job: ({ id }) => Option.some(jobRouter({ id })),
    NotFound: () => Option.none(),
    Pricing: () => Option.some(pricingRouter()),
    Role: ({ place, role }) => Option.some(roleRouter({ place, role })),
    Shortlist: () => Option.none(),
  });

export const addressOf = (url: Url) =>
  Option.match(url.search, {
    onNone: () => url.pathname,
    onSome: (search) => `${url.pathname}?${search}`,
  });
