import type { JobValue } from "@rat-stack/core/contracts";
import { DateTime } from "effect";

import { jobPath } from "./render.js";

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const sitemapXml = (origin: string, jobs: readonly JobValue[]) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `<url><loc>${escapeXml(`${origin}/`)}</loc></url>`,
    ...jobs.map(
      (job) =>
        `<url><loc>${escapeXml(`${origin}${jobPath(job.id)}`)}</loc><lastmod>${DateTime.formatIso(DateTime.makeUnsafe(job.lastSeenAt))}</lastmod></url>`
    ),
    "</urlset>",
  ].join("\n");

export const robotsTxt = (origin: string) =>
  ["User-agent: *", "Allow: /", `Sitemap: ${origin}/sitemap.xml`, ""].join(
    "\n"
  );
