import { SourceTerms } from "@rat-stack/core";
import type { Digest, JobValue } from "@rat-stack/core";
import { Base64Url } from "effect/encoding";

export interface DigestEmail {
  readonly from: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly html: string;
  readonly subject: string;
  readonly text: string;
  readonly to: string;
}

export interface DigestLinks {
  readonly siteOrigin: string;
  readonly unsubscribeToken: string;
}

export const UNSUBSCRIBE_PATH = "/unsubscribe";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const jobLink = (siteOrigin: string, job: Pick<JobValue, "id">) =>
  new URL(`/jobs/${Base64Url.encode(job.id)}`, siteOrigin).href;

export const unsubscribeLink = (siteOrigin: string, token: string) => {
  const url = new URL(UNSUBSCRIBE_PATH, siteOrigin);

  url.searchParams.set("token", token);

  return url.href;
};

const reasonOf = (digest: Digest) =>
  digest.cadence === "Instant"
    ? "You get this within 20 minutes of a new match because you turned on instant alerts for your saved searches."
    : "You get this weekly because you saved a search on Gate Change.";

const instantSubjectOf = (digest: Digest) => {
  const first = digest.jobs[0]?.title ?? "an engineering leadership role";
  const rest = digest.total - 1;

  return rest > 0
    ? `New match: ${first} and ${rest} more`
    : `New match: ${first}`;
};

const weeklySubjectOf = (digest: Digest) =>
  digest.total === 1
    ? "1 new engineering leadership role for your saved searches"
    : `${digest.total} new engineering leadership roles for your saved searches`;

const subjectOf = (digest: Digest) =>
  digest.cadence === "Instant"
    ? instantSubjectOf(digest)
    : weeklySubjectOf(digest);

const placeOf = (job: JobValue) =>
  job.location === "" ? job.company : `${job.company} · ${job.location}`;

const viaOf = (job: JobValue) =>
  SourceTerms[job.source].kind === "Aggregator"
    ? ` (via ${SourceTerms[job.source].label})`
    : "";

const moreNote = (digest: Digest) =>
  digest.total > digest.jobs.length
    ? `Showing the newest ${digest.jobs.length} of ${digest.total}. See the rest on the board.`
    : "";

const htmlItem = (siteOrigin: string, job: JobValue) =>
  [
    '<li style="margin:0 0 16px">',
    `<a href="${escapeHtml(jobLink(siteOrigin, job))}" style="font-weight:600;color:#1a56db;text-decoration:none">${escapeHtml(job.title)}</a>`,
    `<div style="color:#444">${escapeHtml(placeOf(job))}${escapeHtml(viaOf(job))}</div>`,
    ...(job.salary === null
      ? []
      : [`<div style="color:#444">${escapeHtml(job.salary)}</div>`]),
    "</li>",
  ].join("");

const textItem = (siteOrigin: string, job: JobValue) =>
  [
    job.title,
    `${placeOf(job)}${viaOf(job)}`,
    ...(job.salary === null ? [] : [job.salary]),
    jobLink(siteOrigin, job),
  ].join("\n");

export const digestEmail = (
  from: string,
  digest: Digest,
  links: DigestLinks
): DigestEmail => {
  const unsubscribe = unsubscribeLink(links.siteOrigin, links.unsubscribeToken);
  const account = new URL("/account", links.siteOrigin).href;
  const more = moreNote(digest);

  return {
    from,
    headers: {
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    html: [
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
      '<body style="margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.45;color:#111;background:#fff">',
      '<div style="max-width:600px;margin:0 auto;overflow-wrap:anywhere">',
      `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(subjectOf(digest))}</h1>`,
      '<ul style="list-style:none;margin:0;padding:0">',
      ...digest.jobs.map((job) => htmlItem(links.siteOrigin, job)),
      "</ul>",
      ...(more === "" ? [] : [`<p style="color:#444">${escapeHtml(more)}</p>`]),
      '<hr style="border:0;border-top:1px solid #ddd;margin:24px 0">',
      `<p style="font-size:13px;color:#666">${escapeHtml(reasonOf(digest))} <a href="${escapeHtml(account)}" style="color:#666">Manage saved searches</a> or <a href="${escapeHtml(unsubscribe)}" style="color:#666">unsubscribe</a>.</p>`,
      "</div></body></html>",
    ].join(""),
    subject: subjectOf(digest),
    text: [
      subjectOf(digest),
      "",
      ...digest.jobs.map((job) => `${textItem(links.siteOrigin, job)}\n`),
      ...(more === "" ? [] : [more, ""]),
      reasonOf(digest),
      `Manage saved searches: ${account}`,
      `Unsubscribe: ${unsubscribe}`,
    ].join("\n"),
    to: digest.to,
  };
};
