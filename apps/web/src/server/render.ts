import type { JobValue } from "@rat-stack/core/contracts";
import { Option } from "effect";

import { regionLabel, roleLabel, sourceLabel } from "../client/board/copy.js";
import { jobRouter } from "../client/route.js";
import { jobPostingOf, markupPolicy } from "./markup.js";
import type { JobPostingLd, MarkupPolicy } from "./markup.js";

export interface PageHead {
  readonly canonical: string;
  readonly description: string;
  readonly jsonLd: Option.Option<JobPostingLd>;
  readonly title: string;
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

const TITLE = /<title>[^<]*<\/title>/u;

const DESCRIPTION = /<meta\s+name="description"[^>]*\/>/u;

const ROOT = '<div id="root"></div>';

const headTags = (head: PageHead) =>
  [
    `<title>${escapeHtml(head.title)}</title>`,
    `<meta name="description" content="${escapeHtml(head.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(head.canonical)}" />`,
    `<meta property="og:title" content="${escapeHtml(head.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(head.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(head.canonical)}" />`,
    ...Option.match(head.jsonLd, {
      onNone: () => [],
      onSome: (data) => [
        `<script type="application/ld+json">${escapeScript(JSON.stringify(data))}</script>`,
      ],
    }),
  ].join("\n    ");

export const renderShell = (shell: string, head: PageHead, body: string) =>
  shell
    .replace(DESCRIPTION, "")
    .replace(TITLE, headTags(head))
    .replace(ROOT, `<div id="root">${body}</div>`);

export const jobPath = (id: string) => jobRouter({ id });

export const jobHead = (
  job: JobValue,
  origin: string,
  policy: MarkupPolicy = markupPolicy
): PageHead => {
  const canonical = `${origin}${jobPath(job.id)}`;

  return {
    canonical,
    description: `${roleLabel(job.role)} role at ${job.company}, ${regionLabel(job.region)}. ${job.location}`,
    jsonLd: jobPostingOf(job, canonical, policy),
    title: `${job.title} at ${job.company}`,
  };
};

const jobBody = (job: JobValue) =>
  [
    "<main>",
    `<h1>${escapeHtml(job.title)}</h1>`,
    `<p>${escapeHtml(job.company)}, ${escapeHtml(job.location)}</p>`,
    ...(job.salary === null ? [] : [`<p>${escapeHtml(job.salary)}</p>`]),
    `<p><a href="${escapeHtml(job.url)}" rel="nofollow">Apply on ${escapeHtml(sourceLabel(job.source))}</a></p>`,
    '<p><a href="/">See every open role</a></p>',
    "</main>",
  ].join("");

export const renderJobPage = (
  shell: string,
  origin: string,
  path: string,
  job: Option.Option<JobValue>,
  policy: MarkupPolicy = markupPolicy
): RenderedPage =>
  Option.match(job, {
    onNone: () => ({
      html: renderShell(
        shell,
        {
          canonical: `${origin}${path}`,
          description: "This role is no longer listed.",
          jsonLd: Option.none(),
          title: "Role no longer listed",
        },
        '<main><h1>This role is no longer listed</h1><p><a href="/">See every open role</a></p></main>'
      ),
      status: 404,
    }),
    onSome: (found) => ({
      html: renderShell(shell, jobHead(found, origin, policy), jobBody(found)),
      status: 200,
    }),
  });
