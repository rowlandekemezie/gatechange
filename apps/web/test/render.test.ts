import { describe, expect, it } from "@effect/vitest";
import type {
  JobPageValue,
  JobQueryValue,
  JobValue,
  SourceNameValue,
} from "@rat-stack/core/contracts";
import { Effect, Option, Schema } from "effect";
import { fromString } from "foldkit/url";

import indexHtml from "../index.html?raw";
import { Preload } from "../src/client/board/model.js";
import type { PreloadValue } from "../src/client/board/model.js";
import { collectListing } from "../src/client/listing.js";
import { Route, routeOfUrl } from "../src/client/route.js";
import { allowedOnly, allowedOrUnstated } from "../src/server/markup.js";
import type { MarkupPolicy } from "../src/server/markup.js";
import { renderPage } from "../src/server/render.js";
import { robotsTxt, sitemapXml } from "../src/server/sitemap.js";

const ORIGIN = "https://jobs.example";

const routeAt = (path: string) =>
  routeOfUrl(Option.getOrThrow(fromString(`${ORIGIN}${path}`)));

const jobFrom = (
  source: SourceNameValue,
  id: string,
  overrides: Partial<JobValue> = {}
): JobValue => ({
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
  ...overrides,
});

const greenhouse = jobFrom("Greenhouse", "greenhouse:acme/123");

const remotive = jobFrom("Remotive", "remotive:9001");

const GREENHOUSE_PATH = "/jobs/Z3JlZW5ob3VzZTphY21lLzEyMw";

const render = (
  path: string,
  preload: PreloadValue,
  policy: MarkupPolicy = allowedOnly
) =>
  renderPage(
    indexHtml,
    new URL(`${ORIGIN}${path}`),
    routeAt(path),
    preload,
    policy
  );

const renderJob = (job: JobValue, policy: MarkupPolicy) =>
  render(GREENHOUSE_PATH, Preload.Job({ job }), policy);

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

const textOf = (html: string) => html.replaceAll(/<[^>]+>/gu, " ");

describe("job page render", () => {
  it.effect(
    "renders the client view with the job, its own head, and a canonical URL",
    () =>
      Effect.gen(function* jobPage() {
        const page = yield* renderJob(greenhouse, allowedOnly);

        expect(page.status).toBe(200);
        expect(page.html).toContain("data-foldkit-app");
        expect(page.html).toMatch(/<h1[^>]*>Director of Engineering<\/h1>/u);
        expect(page.html).toContain(
          "<title>Director of Engineering at Acme &lt;Robotics&gt;</title>"
        );
        expect(page.html).not.toContain("Refreshed every few hours");
        expect(page.html).toContain(
          `<link rel="canonical" href="${ORIGIN}${GREENHOUSE_PATH}"`
        );
        expect(page.html).toContain(
          '<meta property="og:title" content="Director of Engineering at Acme &lt;Robotics&gt;" />'
        );
        expect(page.html).toContain('href="/companies/acme-robotics"');
      })
  );

  it.effect(
    "emits no JobPosting for a Greenhouse job under the Allowed-only policy",
    () =>
      Effect.map(renderJob(greenhouse, allowedOnly), ({ html }) => {
        expect(Option.isNone(jsonLdOf(html))).toBe(true);
      })
  );

  it.effect(
    "emits a JobPosting for a Greenhouse job under the Allowed-or-Unstated policy",
    () =>
      Effect.map(renderJob(greenhouse, allowedOrUnstated), ({ html }) => {
        expect(Option.getOrThrow(jsonLdOf(html))).toMatchObject({
          "@type": "JobPosting",
          hiringOrganization: { name: "Acme <Robotics>" },
          title: "Director of Engineering",
        });
      })
  );

  it.effect("never emits a JobPosting for a Remotive job", () =>
    Effect.forEach([allowedOnly, allowedOrUnstated], (policy) =>
      Effect.map(renderJob(remotive, policy), ({ html }) => {
        expect(Option.isNone(jsonLdOf(html))).toBe(true);
      })
    )
  );

  it.effect("escapes a closing script tag inside the JobPosting payload", () =>
    Effect.map(
      renderJob(
        { ...greenhouse, company: "</script><script>alert(1)" },
        allowedOrUnstated
      ),
      ({ html }) => {
        expect(html).not.toContain("</script><script>alert(1)");
        expect(Option.getOrThrow(jsonLdOf(html))).toMatchObject({
          hiringOrganization: { name: "</script><script>alert(1)" },
        });
      }
    )
  );

  it.effect("answers a pruned job with 404 and a link back to the board", () =>
    Effect.map(
      render("/jobs/Z29uZQ", Preload.JobMissing(), allowedOrUnstated),
      ({ html, status }) => {
        expect(status).toBe(404);
        expect(textOf(html)).toContain("This role is no longer on the board");
        expect(html).toContain('href="/"');
        expect(Option.isNone(jsonLdOf(html))).toBe(true);
      }
    )
  );
});

const acmeDirector = jobFrom("Greenhouse", "greenhouse:acme/1");

const acmeVp = jobFrom("Lever", "lever:acme/2", {
  role: "VicePresident",
  title: "VP Engineering",
});

describe("listing page render", () => {
  it.effect("a company page lists that company's roles under its name", () =>
    Effect.map(
      render(
        "/companies/acme-robotics",
        Preload.Listing({
          generatedAt: 1_760_500_000_000,
          jobs: [acmeDirector, acmeVp],
        })
      ),
      ({ html, status }) => {
        expect(status).toBe(200);
        expect(html).toContain(
          "<title>Engineering leadership roles at Acme &lt;Robotics&gt;</title>"
        );
        expect(html).toContain(
          `<link rel="canonical" href="${ORIGIN}/companies/acme-robotics"`
        );
        expect(textOf(html)).toContain("2 roles match");
        expect(html.match(/<li[^>]*class="job"/gu)).toHaveLength(2);
        expect(html).toMatch(
          /<meta name="description" content="Engineering leadership roles at Acme &lt;Robotics&gt;: Director of Engineering, VP Engineering\." \/>/u
        );
      }
    )
  );

  it.effect("a role page names the role and place and links each job", () =>
    Effect.map(
      render(
        "/roles/director/remote-canada",
        Preload.Listing({
          generatedAt: 1_760_500_000_000,
          jobs: [acmeDirector],
        })
      ),
      ({ html, status }) => {
        expect(status).toBe(200);
        expect(html).toContain(
          "<title>Director roles remote in Canada</title>"
        );
        expect(html).toContain(
          `<link rel="canonical" href="${ORIGIN}/roles/director/remote-canada"`
        );
        expect(html).toContain('href="/jobs/Z3JlZW5ob3VzZTphY21lLzE"');
      }
    )
  );

  it.effect("an empty listing answers 404 with a link back to the board", () =>
    Effect.map(
      render(
        "/companies/gone-co",
        Preload.Listing({ generatedAt: 1_760_500_000_000, jobs: [] })
      ),
      ({ html, status }) => {
        expect(status).toBe(404);
        expect(textOf(html)).toContain("Nothing is open here right now.");
        expect(html).toContain("Back to open roles");
      }
    )
  );

  it.effect("a malformed company or role path answers 404", () =>
    Effect.forEach(
      [
        "/companies/Acme_Robotics",
        "/roles/ceo/remote-canada",
        "/roles/director",
      ],
      (path) =>
        Effect.map(render(path, Preload.Nothing()), ({ status }) => {
          expect(routeAt(path)._tag, path).toBe("NotFound");
          expect(status, path).toBe(404);
        })
    )
  );
});

const pageOf = (
  jobs: readonly JobValue[],
  query: JobQueryValue
): JobPageValue => ({
  generatedAt: 1_760_500_000_000,
  jobs: jobs.slice(query.offset, query.offset + query.limit),
  total: jobs.length,
});

describe("listing queries", () => {
  it.effect(
    "a company listing keeps only exact company matches across every page",
    () =>
      Effect.gen(function* companyListing() {
        const decoys = Array.from({ length: 150 }, (_, index) =>
          jobFrom("Ashby", `ashby:decoy/${index}`, {
            company: index % 2 === 0 ? "Acme Robotics Labs" : "Other",
            title: "Robotics director",
          })
        );

        const target = jobFrom("Ashby", "ashby:acme/last", {
          company: "ACME, Robotics!",
        });

        const queries: JobQueryValue[] = [];

        const listing = yield* collectListing(
          (query) => {
            queries.push(query);

            return Effect.succeed(pageOf([...decoys, target], query));
          },
          Route.Company({ slug: "acme-robotics" })
        );

        expect(listing.jobs.map((job) => job.id)).toEqual(["ashby:acme/last"]);
        expect(queries.map((query) => query.search)).toEqual([
          "robotics",
          "robotics",
        ]);
      })
  );

  it.effect(
    "a role listing asks for that role in every region of its place",
    () =>
      Effect.gen(function* roleListing() {
        const queries: JobQueryValue[] = [];

        yield* collectListing(
          (query) => {
            queries.push(query);

            return Effect.succeed(pageOf([], query));
          },
          Route.Role({ place: "RemoteCanada", role: "Director" })
        );

        expect(queries).toMatchObject([
          {
            regions: ["RemoteCanada", "RemoteNorthAmerica", "RemoteGlobal"],
            roles: ["Director"],
            search: "",
          },
        ]);
      })
  );
});

const LOC = /<loc>(?<loc>.*?)<\/loc>/gu;

const sitemapRoutes = (jobs: readonly JobValue[]) =>
  [...sitemapXml(ORIGIN, jobs).matchAll(LOC)].map((match) =>
    routeOfUrl(
      Option.getOrThrow(
        fromString((match.groups?.loc ?? "").replaceAll("&amp;", "&"))
      )
    )
  );

describe("sitemap", () => {
  it("lists the board, every job, every company, and each role page with roles", () => {
    const jobs = [
      greenhouse,
      remotive,
      jobFrom("Lever", "lever:ünïcode/?&=", {
        company: "Zeta & Sons",
        region: "BritishColumbia",
        role: "EngineeringManager",
      }),
      jobFrom("Lever", "lever:kanji", { company: "漢字" }),
    ];

    expect(sitemapRoutes(jobs)).toEqual([
      routeAt("/"),
      ...jobs.map((job) => Route.Job({ id: job.id })),
      Route.Company({ slug: "acme-robotics" }),
      Route.Company({ slug: "zeta-sons" }),
      Route.Role({ place: "RemoteCanada", role: "Director" }),
      Route.Role({ place: "BritishColumbia", role: "EngineeringManager" }),
    ]);
  });

  it("points robots at the sitemap", () => {
    expect(robotsTxt(ORIGIN)).toContain(
      "Sitemap: https://jobs.example/sitemap.xml"
    );
  });
});
