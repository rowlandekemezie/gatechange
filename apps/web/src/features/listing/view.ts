import { roleLevels } from "@rat-stack/core/contracts";
import type { JobValue, ListedJobValue } from "@rat-stack/core/contracts";
import { Array, Option, pipe, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import {
  regionGroupChip,
  roleCount,
  roleLabel,
} from "../../client/board/copy.js";
import { defaultFilters, regionGroups } from "../../client/board/filters.js";
import { Message } from "../../client/board/message.js";
import type { MessageValue } from "../../client/board/message.js";
import { ListingState } from "../../client/board/model.js";
import type { ModelValue } from "../../client/board/model.js";
import type { ListingRouteValue } from "../../client/listing.js";
import { boardUrl, Route } from "../../client/route.js";
import { jobRow } from "../board/view.js";

type H = HtmlBuilder<MessageValue>;

const companyNameOf = (slug: string, jobs: readonly JobValue[]) =>
  Option.getOrElse(
    Option.map(Array.head(jobs), (job) => job.company),
    () => slug
  );

export const listingHeading = (
  route: ListingRouteValue,
  jobs: readonly JobValue[]
) =>
  Schema.is(Route.Company)(route)
    ? `Engineering leadership roles at ${companyNameOf(route.slug, jobs)}`
    : `${roleLabel(route.role)} roles ${regionGroupChip(route.place)}`;

const boardLinkOf = (route: ListingRouteValue) =>
  Schema.is(Route.Role)(route)
    ? boardUrl({
        ...defaultFilters,
        maxAgeDays: 30,
        regionGroups: [route.place],
        roles: [route.role],
      })
    : boardUrl(defaultFilters);

const backLink = (h: H, route: ListingRouteValue): Html =>
  h.a([h.Class("back"), h.Href(boardLinkOf(route))], ["Back to open roles"]);

const everyRoleOf = (route: ListingRouteValue, jobs: readonly JobValue[]) =>
  Schema.is(Route.Company)(route)
    ? boardUrl({
        ...defaultFilters,
        maxAgeDays: 30,
        regionGroups,
        roles: roleLevels,
        salaryListed: false,
        search: companyNameOf(route.slug, jobs),
        sort: "Newest",
      })
    : boardLinkOf(route);

const moreLink = (
  h: H,
  route: ListingRouteValue,
  jobs: readonly JobValue[],
  total: number
): readonly Html[] =>
  total > jobs.length
    ? [
        h.p(
          [h.Class("list-end")],
          [
            h.a(
              [h.Href(everyRoleOf(route, jobs))],
              [`See all ${total} on the board`]
            ),
          ]
        ),
      ]
    : [];

const loadedView = (
  model: ModelValue,
  h: H,
  route: ListingRouteValue,
  generatedAt: number,
  jobs: readonly ListedJobValue[],
  total: number
): Html =>
  Array.isReadonlyArrayEmpty(jobs)
    ? h.div(
        [h.Class("empty detail"), h.Role("alert")],
        [
          h.h1([h.Class("detail-title")], [listingHeading(route, jobs)]),
          h.p([], ["Nothing is open here right now."]),
          backLink(h, route),
        ]
      )
    : h.section(
        [h.Class("listing")],
        [
          backLink(h, route),
          h.h1([h.Class("detail-title")], [listingHeading(route, jobs)]),
          h.p([h.Class("count")], [roleCount(total)]),
          h.ol(
            [h.Class("jobs")],
            pipe(
              jobs,
              Array.map((job) => jobRow(model, h, job, generatedAt))
            )
          ),
          ...moreLink(h, route, jobs, total),
        ]
      );

export const listingPage = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): Html =>
  ListingState.match<Html>(model.listing, {
    Failed: ({ message, route }) =>
      h.div(
        [h.Class("empty detail"), h.Role("alert")],
        [
          h.h1([h.Class("detail-title")], ["These roles could not load"]),
          h.p([], [message]),
          h.button(
            [
              h.Type("button"),
              h.Class("more"),
              h.OnClick(Message.ClickedRetryListing()),
            ],
            ["Try again"]
          ),
          backLink(h, route),
        ]
      ),
    Loaded: ({ generatedAt, jobs, route, total }) =>
      loadedView(model, h, route, generatedAt, jobs, total),
    Loading: () =>
      h.div(
        [h.Class("empty detail"), h.Role("status")],
        [h.h1([h.Class("detail-title")], ["Finding roles"])]
      ),
    NotAsked: () => h.empty,
  });

export const listingTitle = (model: ModelValue) =>
  ListingState.match<string>(model.listing, {
    Failed: () => "Roles unavailable",
    Loaded: ({ jobs, route }) => listingHeading(route, jobs),
    Loading: ({ route }) => listingHeading(route, []),
    NotAsked: () => "Engineering leadership roles",
  });
