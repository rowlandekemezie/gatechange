import {
  CompanySummary,
  COMPANY_LISTING_ROWS,
  EpochMillis,
  JobDetail,
  MAX_AGE_DAYS,
  MAX_PAGE_SIZE,
  roleLevels,
} from "@rat-stack/core/contracts";
import type {
  CompanyJobsValue,
  JobPageValue,
  JobQueryValue,
  RegionValue,
  RoleLevelValue,
} from "@rat-stack/core/contracts";
import { Array, Effect, pipe, Schema } from "effect";

import { regionGroups, regionsOfGroup } from "./board/filters.js";
import type { RegionGroupValue } from "./board/filters.js";
import { Route } from "./route.js";

export const ListingRoute = Schema.Union([Route.Company, Route.Role]);

export type ListingRouteValue = typeof ListingRoute.Type;

export const isListingRoute = Schema.is(ListingRoute);

export const LISTING_ROWS = COMPANY_LISTING_ROWS;

export const Listing = Schema.Struct({
  generatedAt: EpochMillis,
  jobs: Schema.Array(JobDetail),
  summary: Schema.NullOr(CompanySummary),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type ListingValue = typeof Listing.Type;

const baseQuery = {
  limit: MAX_PAGE_SIZE,
  maxAgeDays: MAX_AGE_DAYS,
  offset: 0,
  salaryFloor: null,
  salaryListed: false,
  seniorities: [],
} as const;

export const collectListing = <E, R>(
  queries: {
    readonly listJobs: (
      query: JobQueryValue
    ) => Effect.Effect<JobPageValue, E, R>;
    readonly companyJobs: (
      slug: string
    ) => Effect.Effect<CompanyJobsValue, E, R>;
  },
  route: ListingRouteValue
): Effect.Effect<ListingValue, E, R> =>
  Schema.is(Route.Company)(route)
    ? queries.companyJobs(route.slug)
    : Effect.map(
        queries.listJobs({
          ...baseQuery,
          limit: LISTING_ROWS,
          regions: pipe(regionsOfGroup(route.place), Array.dedupe),
          roles: [route.role],
          search: "",
          sort: "Relevance",
        }),
        (page) => ({
          generatedAt: page.generatedAt,
          jobs: page.jobs,
          summary: null,
          total: page.total,
        })
      );

export interface RoleHub {
  readonly place: RegionGroupValue;
  readonly role: RoleLevelValue;
}

export const roleHubsWhere = (
  isOpen: (role: RoleLevelValue, region: RegionValue) => boolean
): readonly RoleHub[] =>
  pipe(
    roleLevels,
    Array.flatMap((role) =>
      pipe(
        regionGroups,
        Array.filter((place) =>
          regionsOfGroup(place).some((region) => isOpen(role, region))
        ),
        Array.map((place) => ({ place, role }))
      )
    )
  );
