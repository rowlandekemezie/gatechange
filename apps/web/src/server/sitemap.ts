import { companySlugOf, roleLevels } from "@rat-stack/core/contracts";
import type { JobValue } from "@rat-stack/core/contracts";
import { Array, DateTime, pipe } from "effect";

import { regionGroups, regionsOfGroup } from "../client/board/filters.js";
import { companyRouter, jobRouter, roleRouter } from "../client/route.js";

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const urlEntry = (origin: string, path: string, lastSeenAt?: number) =>
  `<url><loc>${escapeXml(`${origin}${path}`)}</loc>${
    lastSeenAt === undefined
      ? ""
      : `<lastmod>${DateTime.formatIso(DateTime.makeUnsafe(lastSeenAt))}</lastmod>`
  }</url>`;

const companyPaths = (jobs: readonly JobValue[]) =>
  pipe(
    jobs,
    Array.map((job) => companySlugOf(job.company)),
    Array.getSomes,
    Array.dedupe,
    Array.map((slug) => companyRouter({ slug }))
  );

const rolePaths = (jobs: readonly JobValue[]) =>
  pipe(
    roleLevels,
    Array.flatMap((role) =>
      pipe(
        regionGroups,
        Array.filter((place) =>
          jobs.some(
            (job) =>
              job.role === role &&
              Array.contains(regionsOfGroup(place), job.region)
          )
        ),
        Array.map((place) => roleRouter({ place, role }))
      )
    )
  );

export const sitemapXml = (origin: string, jobs: readonly JobValue[]) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urlEntry(origin, "/"),
    ...jobs.map((job) =>
      urlEntry(origin, jobRouter({ id: job.id }), job.lastSeenAt)
    ),
    ...companyPaths(jobs).map((path) => urlEntry(origin, path)),
    ...rolePaths(jobs).map((path) => urlEntry(origin, path)),
    "</urlset>",
  ].join("\n");

export const robotsTxt = (origin: string) =>
  ["User-agent: *", "Allow: /", `Sitemap: ${origin}/sitemap.xml`, ""].join(
    "\n"
  );

export const closedRobotsTxt = ["User-agent: *", "Disallow: /", ""].join("\n");
