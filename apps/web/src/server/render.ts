import type { JobValue } from "@rat-stack/core/contracts";
import { Array, Data, Effect, Option, Schema } from "effect";
import { renderToString } from "foldkit/experimental/server";

import { application } from "../client/application.js";
import { regionLabel, roleLabel } from "../client/board/copy.js";
import { Preload } from "../client/board/model.js";
import type { PreloadValue } from "../client/board/model.js";
import { Route } from "../client/route.js";
import type { RouteValue } from "../client/route.js";
import { informationMeta } from "../features/information/view.js";
import { listingHeading } from "../features/listing/view.js";
import { jobPostingOf, markupPolicy } from "./markup.js";
import type { JobPostingLd, MarkupPolicy } from "./markup.js";

export interface PageMeta {
  readonly description: string;
  readonly jsonLd: Option.Option<JobPostingLd>;
  readonly status: 200 | 404;
}

export interface RenderedPage {
  readonly html: string;
  readonly status: 200 | 404;
}

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const escapeScript = (json: string) => json.replaceAll("<", String.raw`\u003c`);

const DESCRIPTION = /<meta\s+name="description"[^>]*\/>/u;

const HEAD_END = "</head>";

const ROOT = '<div id="root"></div>';

const TITLE = /<title>[^<]*<\/title>/u;

class ShellMismatch extends Data.TaggedError("ShellMismatch") {}

const occursOnce = (text: string, part: string) =>
  text.includes(part) && text.indexOf(part) === text.lastIndexOf(part);

const missing = (description: string): PageMeta => ({
  description,
  jsonLd: Option.none(),
  status: 404,
});

const comparable = (text: string) =>
  text.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");

const placeOf = (job: JobValue) => {
  const region = regionLabel(job.region);

  return comparable(job.location) === comparable(region)
    ? region
    : `${region}. ${job.location}`;
};

const jobMeta = (job: JobValue, canonical: string, policy: MarkupPolicy) => ({
  description: `${roleLabel(job.role)} role at ${job.company}, ${placeOf(job)}`,
  jsonLd: jobPostingOf(job, canonical, policy),
  status: 200 as const,
});

const listingMeta = (route: RouteValue, jobs: readonly JobValue[]) =>
  Schema.is(Route.Company)(route) || Schema.is(Route.Role)(route)
    ? Option.match(Array.head(jobs), {
        onNone: () => missing("Nothing is open here right now."),
        onSome: () => ({
          description: `${listingHeading(route, jobs)}: ${jobs
            .slice(0, 3)
            .map((job) => job.title)
            .join(
              ", "
            )}${jobs.length > 3 ? `, and ${jobs.length - 3} more` : ""}.`,
          jsonLd: Option.none(),
          status: 200 as const,
        }),
      })
    : missing("There is no page here.");

const publicMeta = (route: RouteValue): PageMeta => {
  if (Schema.is(Route.Pricing)(route)) {
    return {
      description:
        "Every engineering leadership listing stays free. Compare Jobs Pro plans for faster alerts, salary filters and company intel. Prices in US dollars.",
      jsonLd: Option.none(),
      status: 200,
    };
  }

  if (Schema.is(Route.Information)(route)) {
    return {
      description: informationMeta(route.page).description,
      jsonLd: Option.none(),
      status: 200,
    };
  }

  return missing("There is no page here.");
};

export const pageMeta = (
  route: RouteValue,
  preload: PreloadValue,
  canonical: string,
  policy: MarkupPolicy = markupPolicy
): PageMeta =>
  Preload.match<PageMeta>(preload, {
    Board: () => ({
      description:
        "Find engineering manager, director, head of engineering and VP roles. Browse current leadership jobs, filter by where you can work, and apply at the original source for free.",
      jsonLd: Option.none(),
      status: 200,
    }),
    Job: ({ job }) => jobMeta(job, canonical, policy),
    JobMissing: () => missing("This role is no longer listed."),
    Listing: ({ jobs }) => listingMeta(route, jobs),
    Nothing: () => publicMeta(route),
  });

const headTags = (
  title: string,
  canonical: string | undefined,
  meta: PageMeta,
  noindex: boolean
) =>
  [
    ...(noindex ? ['<meta name="robots" content="noindex" />'] : []),
    ...(canonical === undefined
      ? []
      : [
          `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
          `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
        ]),
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    ...Option.match(meta.jsonLd, {
      onNone: () => [],
      onSome: (data) => [
        `<script type="application/ld+json">${escapeScript(JSON.stringify(data))}</script>`,
      ],
    }),
    HEAD_END,
  ].join("\n    ");

export const renderPage = (
  shell: string,
  url: URL,
  route: RouteValue,
  preload: PreloadValue,
  policy: MarkupPolicy = markupPolicy
) =>
  Effect.gen(function* renderServerPage() {
    const rendered = yield* renderToString(application, {
      flags: { origin: url.origin, preload },
      url: url.href,
    });

    const meta = pageMeta(
      route,
      preload,
      rendered.canonical ?? url.href,
      policy
    );

    if (!occursOnce(shell, ROOT) || !TITLE.test(shell)) {
      return yield* new ShellMismatch();
    }

    return {
      html: shell
        .replace(ROOT, () => rendered.html)
        .replace(TITLE, () => `<title>${escapeHtml(rendered.title)}</title>`)
        .replace(
          DESCRIPTION,
          () =>
            `<meta name="description" content="${escapeHtml(meta.description)}" />`
        )
        .replace(HEAD_END, () =>
          headTags(
            rendered.title,
            rendered.canonical,
            meta,
            Schema.is(Route.Board)(route) && url.search !== ""
          )
        ),
      status: meta.status,
    } satisfies RenderedPage;
  });
