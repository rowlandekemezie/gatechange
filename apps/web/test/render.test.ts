import { describe, expect, it } from "@effect/vitest";
import type { JobValue, SourceNameValue } from "@rat-stack/core/contracts";
import { Option, Schema } from "effect";
import { fromString } from "foldkit/url";

import indexHtml from "../index.html?raw";
import { Route, routeOfUrl } from "../src/client/route.js";
import { allowedOnly, allowedOrUnstated } from "../src/server/markup.js";
import type { MarkupPolicy } from "../src/server/markup.js";
import { renderJobPage } from "../src/server/render.js";
import { robotsTxt, sitemapXml } from "../src/server/sitemap.js";

const ORIGIN = "https://jobs.example";

const SHELL = indexHtml;

const jobFrom = (source: SourceNameValue, id: string): JobValue => ({
  arrangement: "Remote",
  company: "Acme <Robotics>",
  feed: `${source}:acme`,
  firstSeenAt: 1_760_000_000_000,
  id,
  lastSeenAt: 1_760_500_000_000,
  location: "Remote, Canada",
  postedAt: 1_760_000_000_000,
  region: "RemoteCanada",
  relevance: 10,
  role: "Director",
  salary: "$200k",
  source,
  title: "Director of Engineering",
  url: `https://boards.example/${id}`,
});

const greenhouse = jobFrom("Greenhouse", "greenhouse:acme/123");

const remotive = jobFrom("Remotive", "remotive:9001");

const render = (job: JobValue, policy: MarkupPolicy) =>
  renderJobPage(SHELL, ORIGIN, "/jobs/x", Option.some(job), policy);

const JSON_LD = /<script type="application\/ld\+json">(?<json>.*?)<\/script>/su;

const JobPostingProbe = Schema.fromJsonString(
  Schema.Struct({
    "@type": Schema.String,
    hiringOrganization: Schema.Struct({ name: Schema.String }),
    title: Schema.String,
  })
);

const jsonLdOf = (html: string) =>
  Option.map(Option.fromNullishOr(JSON_LD.exec(html)), (match) =>
    Schema.decodeUnknownSync(JobPostingProbe)(match.groups?.json)
  );

describe("job page render", () => {
  it("server-renders the job title, its own head, and a canonical job URL", () => {
    const page = render(greenhouse, allowedOnly);

    expect(page.status).toBe(200);
    expect(page.html).toContain("<h1>Director of Engineering</h1>");
    expect(page.html).toContain(
      "<title>Director of Engineering at Acme &lt;Robotics&gt;</title>"
    );
    expect(page.html).not.toContain("Refreshed every few hours");
    expect(page.html).toContain(
      '<link rel="canonical" href="https://jobs.example/jobs/Z3JlZW5ob3VzZTphY21lLzEyMw" />'
    );
  });

  it("emits no JobPosting for a Greenhouse job under the Allowed-only policy", () => {
    expect(Option.isNone(jsonLdOf(render(greenhouse, allowedOnly).html))).toBe(
      true
    );
  });

  it("emits a JobPosting for a Greenhouse job under the Allowed-or-Unstated policy", () => {
    const jsonLd = jsonLdOf(render(greenhouse, allowedOrUnstated).html);

    expect(Option.getOrThrow(jsonLd)).toMatchObject({
      "@type": "JobPosting",
      hiringOrganization: { name: "Acme <Robotics>" },
      title: "Director of Engineering",
    });
  });

  it("never emits a JobPosting for a Remotive job", () => {
    for (const policy of [allowedOnly, allowedOrUnstated]) {
      expect(Option.isNone(jsonLdOf(render(remotive, policy).html))).toBe(true);
    }
  });

  it("escapes a closing script tag inside the JobPosting payload", () => {
    const hostile = { ...greenhouse, company: "</script><script>alert(1)" };
    const { html } = render(hostile, allowedOrUnstated);

    expect(html).not.toContain("</script><script>alert(1)");
    expect(Option.getOrThrow(jsonLdOf(html))).toMatchObject({
      hiringOrganization: { name: "</script><script>alert(1)" },
    });
  });

  it("answers a pruned job with 404 and a link back to the board", () => {
    const page = renderJobPage(
      SHELL,
      ORIGIN,
      "/jobs/Z29uZQ",
      Option.none(),
      allowedOrUnstated
    );

    expect(page.status).toBe(404);
    expect(page.html).toContain('<a href="/">See every open role</a>');
    expect(Option.isNone(jsonLdOf(page.html))).toBe(true);
  });
});

const LOC = /<loc>(?<loc>.*?)<\/loc>/gu;

describe("sitemap", () => {
  it("lists the board and one URL per job, each resolving to that job's route", () => {
    const jobs = [greenhouse, remotive, jobFrom("Lever", "lever:ünïcode/?&=")];

    const urls = [...sitemapXml(ORIGIN, jobs).matchAll(LOC)].map((match) =>
      (match.groups?.loc ?? "").replaceAll("&amp;", "&")
    );

    expect(urls[0]).toBe(`${ORIGIN}/`);
    expect(
      urls.slice(1).map((url) => {
        const route = routeOfUrl(Option.getOrThrow(fromString(url)));

        return Schema.is(Route.Job)(route) ? route.id : route._tag;
      })
    ).toEqual(jobs.map((job) => job.id));
  });

  it("points robots at the sitemap", () => {
    expect(robotsTxt(ORIGIN)).toContain(
      "Sitemap: https://jobs.example/sitemap.xml"
    );
  });
});
