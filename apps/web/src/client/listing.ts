import {
  EpochMillis,
  Job,
  MAX_AGE_DAYS,
  MAX_PAGE_SIZE,
} from "@rat-stack/core/contracts";
import type {
  JobPageValue,
  JobQueryValue,
  JobValue,
} from "@rat-stack/core/contracts";
import { Array, Effect, Option, pipe, Schema } from "effect";

import { regionsOfGroup } from "./board/filters.js";
import { companySlugOf, Route } from "./route.js";

export const ListingRoute = Schema.Union([Route.Company, Route.Role]);

export type ListingRouteValue = typeof ListingRoute.Type;

export const isListingRoute = Schema.is(ListingRoute);

export const LISTING_ROWS = 12;

export const Listing = Schema.Struct({
  generatedAt: EpochMillis,
  jobs: Schema.Array(Job),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type ListingValue = typeof Listing.Type;

const COMPANY_PAGES = 5;

export const longestWord = (slug: string) => {
  let longest = "";

  for (const word of slug.split("-")) {
    if (word.length > longest.length) {
      longest = word;
    }
  }

  return longest;
};

const baseQuery = {
  limit: MAX_PAGE_SIZE,
  maxAgeDays: MAX_AGE_DAYS,
  offset: 0,
  salaryListed: false,
} as const;

const companyQuery = (slug: string, offset: number): JobQueryValue => ({
  ...baseQuery,
  offset,
  regions: [],
  roles: [],
  search: longestWord(slug).slice(0, 80),
  sort: "Newest",
});

const isAtCompany = (slug: string) => (job: JobValue) =>
  Option.contains(companySlugOf(job.company), slug);

export const collectListing = <E, R>(
  listJobs: (query: JobQueryValue) => Effect.Effect<JobPageValue, E, R>,
  route: ListingRouteValue
): Effect.Effect<ListingValue, E, R> =>
  Schema.is(Route.Company)(route)
    ? Effect.gen(function* collectCompanyJobs() {
        const seen: JobValue[] = [];
        let generatedAt = 0;

        for (let page = 0; page < COMPANY_PAGES; page += 1) {
          const result = yield* listJobs(
            companyQuery(route.slug, page * MAX_PAGE_SIZE)
          );

          ({ generatedAt } = result);
          seen.push(...result.jobs);

          if (seen.length >= result.total || result.jobs.length === 0) {
            break;
          }
        }

        const matching = pipe(seen, Array.filter(isAtCompany(route.slug)));

        return {
          generatedAt,
          jobs: matching.slice(0, LISTING_ROWS),
          total: matching.length,
        };
      })
    : Effect.map(
        listJobs({
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
          total: page.total,
        })
      );
