import { companySlugOf } from "@rat-stack/core/contracts";
import type { SitemapJobValue } from "@rat-stack/core/contracts";
import { Array, DateTime, Option, pipe } from "effect";

import { regionsOfGroup } from "../client/board/filters.js";
import { roleHubsWhere } from "../client/listing.js";
import {
  companyRouter,
  InformationPage,
  informationRouter,
  jobRouter,
  pricingRouter,
  roleRouter,
} from "../client/route.js";

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const urlEntry = (
  origin: string,
  path: string,
  listedAt: Option.Option<number>
) =>
  `<url><loc>${escapeXml(`${origin}${path}`)}</loc>${Option.match(listedAt, {
    onNone: () => "",
    onSome: (at) =>
      `<lastmod>${DateTime.formatIso(DateTime.makeUnsafe(at))}</lastmod>`,
  })}</url>`;

const newestListingOf = (jobs: readonly SitemapJobValue[]) =>
  Option.liftPredicate(
    Math.max(...jobs.map((job) => job.firstSeenAt)),
    Number.isFinite
  );

export const emptySitemapXml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
].join("\n");

const companyEntries = (origin: string, jobs: readonly SitemapJobValue[]) =>
  pipe(
    jobs,
    Array.groupBy((job) =>
      Option.getOrElse(companySlugOf(job.company), () => "")
    ),
    (groups) => Object.entries(groups),
    Array.filter(([slug]) => slug !== ""),
    Array.map(([slug, listed]) =>
      urlEntry(origin, companyRouter({ slug }), newestListingOf(listed))
    )
  );

const roleEntries = (origin: string, jobs: readonly SitemapJobValue[]) =>
  roleHubsWhere((role, region) =>
    jobs.some((job) => job.role === role && job.region === region)
  ).map(({ place, role }) =>
    urlEntry(
      origin,
      roleRouter({ place, role }),
      newestListingOf(
        jobs.filter(
          (job) =>
            job.role === role &&
            Array.contains(regionsOfGroup(place), job.region)
        )
      )
    )
  );

export const sitemapXml = (origin: string, jobs: readonly SitemapJobValue[]) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urlEntry(origin, "/", newestListingOf(jobs)),
    urlEntry(origin, pricingRouter(), Option.none()),
    ...InformationPage.literals.map((page) =>
      urlEntry(origin, informationRouter(page), Option.none())
    ),
    ...jobs.map((job) =>
      urlEntry(origin, jobRouter({ id: job.id }), Option.some(job.firstSeenAt))
    ),
    ...companyEntries(origin, jobs),
    ...roleEntries(origin, jobs),
    "</urlset>",
  ].join("\n");

export const robotsTxt = (origin: string) =>
  ["User-agent: *", "Allow: /", `Sitemap: ${origin}/sitemap.xml`, ""].join(
    "\n"
  );

export const closedRobotsTxt = ["User-agent: *", "Disallow: /", ""].join("\n");
