import { describe, expect, it } from "@effect/vitest";
import type {
  JobPageValue,
  TrackedJobValue,
  JobQueryValue,
  JobValue,
  ListedJobValue,
  SourceNameValue,
} from "@rat-stack/core/contracts";
import { Effect, Option, Schema } from "effect";
import { renderToString } from "foldkit/experimental/server";
import { fromString } from "foldkit/url";

import indexHtml from "../index.html?raw";
import { application } from "../src/client/application.js";
import {
  ImportOffer,
  Preload,
  TrackerState,
} from "../src/client/board/model.js";
import type {
  MarkedJobValue,
  PreloadValue,
} from "../src/client/board/model.js";
import { collectListing, LISTING_ROWS } from "../src/client/listing.js";
import { jobRouter, Route, routeOfUrl } from "../src/client/route.js";
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
  overrides: Partial<ListedJobValue> = {}
): ListedJobValue => ({
  arrangement: "Remote",
  company: "Acme <Robotics>",
  daysOpen: 0,
  feed: `${source}:acme`,
  firstSeenAt: 1_760_000_000_000,
  id,
  lastSeenAt: 1_760_500_000_000,
  location: "Remote, Canada",
  postedAt: 1_760_000_000_000,
  region: "RemoteCanada",
  relevance: 10,
  reposts: 0,
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

const SITE = "https://jobs.rowlandekemezie.com";

const OWN_LINKS = [
  `${SITE}/api/auth/magic-link/verify?token=x`,
  "https:/api/auth/magic-link/verify?token=x&callbackURL=/account",
  "HTTPS:/api/auth/magic-link/verify?token=x",
  "https:\\api/auth/magic-link/verify?token=x",
  " https:/api/auth/magic-link/verify?token=x",
  "https:\t/api/auth/magic-link/verify?token=x",
  "https:/account/confirm?token=x",
  "https:api/auth/magic-link/verify?token=x",
];

const HREF = /href="(?<href>[^"]*)"/gu;

const linksHome = (html: string, path: string) =>
  Array.from(html.matchAll(HREF), (match) =>
    URL.parse(
      (match.groups?.href ?? "").replaceAll("&amp;", "&"),
      `${ORIGIN}${path}`
    )
  )
    .filter(
      (url) =>
        url !== null &&
        [ORIGIN, SITE].includes(url.origin) &&
        url.searchParams.has("token")
    )
    .map(String);

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

  it.effect(
    "emits no JobPosting for a Greenhouse job under the default policy",
    () =>
      Effect.map(
        renderPage(
          indexHtml,
          new URL(`${ORIGIN}${GREENHOUSE_PATH}`),
          routeAt(GREENHOUSE_PATH),
          Preload.Job({ job: greenhouse })
        ),
        ({ html }) => {
          expect(Option.isNone(jsonLdOf(html))).toBe(true);
        }
      )
  );

  it.effect("names the place once when the location repeats the region", () =>
    Effect.map(
      renderJob(
        { ...greenhouse, location: "Remote US", region: "RemoteUnitedStates" },
        allowedOnly
      ),
      ({ html }) => {
        expect(html).toContain(
          '<meta name="description" content="Director role at Acme &lt;Robotics&gt;, Remote, US" />'
        );
      }
    )
  );

  it.effect("keeps a location that adds to the region", () =>
    Effect.map(
      renderJob(
        { ...greenhouse, location: "Austin, TX", region: "UnitedStatesOnsite" },
        allowedOnly
      ),
      ({ html }) => {
        expect(html).toContain(
          '<meta name="description" content="Director role at Acme &lt;Robotics&gt;, United States. Austin, TX" />'
        );
      }
    )
  );

  it.effect("declares the Open Graph type and a summary card", () =>
    Effect.map(renderJob(greenhouse, allowedOnly), ({ html }) => {
      expect(html).toContain('<meta property="og:type" content="website" />');
      expect(html).toContain('<meta name="twitter:card" content="summary" />');
    })
  );

  it.effect("escapes double quotes from job data inside head attributes", () =>
    Effect.map(
      renderJob(
        { ...greenhouse, company: 'Acme" onload="alert(1)' },
        allowedOnly
      ),
      ({ html }) => {
        expect(html).not.toMatch(/<[^>]*\sonload="/u);
        expect(html).toContain(
          '<meta property="og:title" content="Director of Engineering at Acme&quot; onload=&quot;alert(1)" />'
        );
      }
    )
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

  it.effect("keeps dollar patterns in listing data literal", () =>
    Effect.map(
      renderJob(
        { ...greenhouse, company: "Cash $& Carry $'", title: "Lead $` ops" },
        allowedOnly
      ),
      ({ html }) => {
        expect(html).toContain(
          "<title>Lead $` ops at Cash $&amp; Carry $'</title>"
        );
        expect(html).toContain(
          '<meta name="description" content="Director role at Cash $&amp; Carry $\', Remote, Canada" />'
        );
        expect(textOf(html)).toContain("Cash $&amp; Carry $'");
      }
    )
  );

  it.effect("links the apply button to an off-site posting", () =>
    Effect.map(renderJob(greenhouse, allowedOnly), ({ html }) => {
      expect(html).toContain(`href="${greenhouse.url}"`);
    })
  );

  it.effect.each(OWN_LINKS)(
    "never links the apply button home through %s",
    (url) =>
      Effect.map(
        renderJob(
          jobFrom("Greenhouse", "greenhouse:acme/123", { url }),
          allowedOnly
        ),
        ({ html }) => {
          expect(html).toMatch(/<a class="apply"[^>]*>Apply on/u);
          expect(linksHome(html, GREENHOUSE_PATH)).toStrictEqual([]);
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

const markOf = (job: ListedJobValue): MarkedJobValue => ({
  company: job.company,
  id: job.id,
  kind: "Saved",
  location: job.location,
  title: job.title,
  url: job.url,
});

const renderRemoteTracker = (jobs: readonly TrackedJobValue[]) =>
  renderToString(
    {
      ...application,
      init: (...args: Parameters<typeof application.init>) => {
        const started = application.init(...args);

        return {
          ...started,
          model: {
            ...started.model,
            tracker: TrackerState.Remote({
              adding: [],
              jobs,
              loaded: true,
              offer: ImportOffer.None(),
              problem: Option.none(),
            }),
          },
        };
      },
    },
    {
      flags: { origin: ORIGIN, preload: Preload.Nothing() },
      url: `${ORIGIN}/shortlist`,
    }
  );

const trackedFrom = (job: ListedJobValue, url: string): TrackedJobValue => ({
  jobId: job.id,
  listed: true,
  movedAt: 1_760_000_000_000,
  notes: "",
  savedAt: 1_760_000_000_000,
  snapshot: {
    company: job.company,
    location: job.location,
    title: job.title,
    url,
  },
  stage: "Saved",
});

const renderTracking = (
  path: string,
  preload: PreloadValue,
  marks: readonly MarkedJobValue[]
) =>
  renderToString(
    {
      ...application,
      init: (...args: Parameters<typeof application.init>) => {
        const started = application.init(...args);

        return { ...started, model: { ...started.model, marks } };
      },
    },
    { flags: { origin: ORIGIN, preload }, url: `${ORIGIN}${path}` }
  );

describe("original posting links", () => {
  it.effect.each(OWN_LINKS)("never links a listed row home through %s", (url) =>
    Effect.map(
      render(
        "/companies/acme-robotics",
        Preload.Listing({
          generatedAt: 1_760_500_000_000,
          jobs: [{ ...acmeDirector, url }, acmeVp],
          total: 2,
        })
      ),
      ({ html }) => {
        expect(html.match(/<a class="job-source"/gu)).toHaveLength(2);
        expect(html).toContain(`href="${acmeVp.url}"`);
        expect(linksHome(html, "/companies/acme-robotics")).toStrictEqual([]);
      }
    )
  );

  it.effect("renders no href for a host outside DNS characters", () =>
    Effect.map(
      render(
        "/companies/acme-robotics",
        Preload.Listing({
          generatedAt: 1_760_500_000_000,
          jobs: [
            {
              ...acmeDirector,
              url: `${SITE}&sol;api/auth/magic-link/verify?token=x`,
            },
            acmeVp,
          ],
          total: 2,
        })
      ),
      ({ html }) => {
        expect(html.match(/<a class="job-source"/gu)).toHaveLength(2);
        expect(html).toContain(`href="${acmeVp.url}"`);
        expect(html).not.toMatch(/href="[^"]*sol;api/u);
      }
    )
  );

  it.effect.each(OWN_LINKS)(
    "never links a shortlist mark home through %s",
    (url) =>
      Effect.map(
        renderTracking("/shortlist", Preload.Nothing(), [
          { ...markOf(acmeDirector), url },
          markOf(acmeVp),
        ]),
        ({ html }) => {
          expect(html.match(/<a class="job-source"/gu)).toHaveLength(2);
          expect(html).toContain(`href="${acmeVp.url}"`);
          expect(linksHome(html, "/shortlist")).toStrictEqual([]);
        }
      )
  );

  it.effect.each(OWN_LINKS)(
    "never links a pruned job's mark home through %s",
    (url) =>
      Effect.map(
        renderTracking(
          jobRouter({ id: acmeDirector.id }),
          Preload.JobMissing(),
          [{ ...markOf(acmeDirector), url }]
        ),
        ({ html }) => {
          expect(textOf(html)).toContain("Open the original posting");
          expect(
            linksHome(html, jobRouter({ id: acmeDirector.id }))
          ).toStrictEqual([]);
        }
      )
  );
});

const OWN_VERIFY = `${SITE}/api/auth/magic-link/verify?token=x`;

describe("tracker row original posting link", () => {
  it.effect.each(OWN_LINKS)(
    "never links a tracker row home through %s",
    (url) =>
      Effect.map(
        renderRemoteTracker([
          trackedFrom(acmeDirector, url),
          trackedFrom(acmeVp, acmeVp.url),
        ]),
        ({ html }) => {
          expect(html.match(/<a class="job-source"/gu)).toHaveLength(2);
          expect(html).toContain(`href="${acmeVp.url}"`);
          expect(linksHome(html, "/shortlist")).toStrictEqual([]);
        }
      )
  );

  it.effect(
    "links a tracker row only to an absolute posting off this site",
    () =>
      Effect.map(
        renderRemoteTracker([
          trackedFrom(acmeDirector, OWN_VERIFY),
          trackedFrom(acmeVp, "/jobs/legacy-relative"),
          trackedFrom(acmeVp, "ftp://files.example.com/old"),
          trackedFrom(acmeVp, acmeVp.url),
        ]),
        ({ html }) => {
          expect(html.match(/<a class="job-source"/gu)).toHaveLength(4);
          expect(html).not.toContain(`href="${OWN_VERIFY}"`);
          expect(html).not.toContain('href="/jobs/legacy-relative"');
          expect(html).not.toContain("ftp://files.example.com");
          expect(html).toContain(`href="${acmeVp.url}"`);
        }
      )
  );
});

describe("listing page render", () => {
  it.effect("a company page lists that company's roles under its name", () =>
    Effect.map(
      render(
        "/companies/acme-robotics",
        Preload.Listing({
          generatedAt: 1_760_500_000_000,
          jobs: [acmeDirector, acmeVp],
          total: 2,
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
          total: 30,
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
        expect(textOf(html)).toContain("30 roles match");
        expect(html).toContain(
          'href="/?age=30&amp;place=remote-canada&amp;role=director"'
        );
        expect(textOf(html)).toContain("See all 30 on the board");
      }
    )
  );

  it.effect("an empty listing answers 404 with a link back to the board", () =>
    Effect.map(
      render(
        "/companies/gone-co",
        Preload.Listing({ generatedAt: 1_760_500_000_000, jobs: [], total: 0 })
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
  jobs: readonly ListedJobValue[],
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
        expect(listing.total).toBe(1);
        expect(queries.map((query) => query.search)).toEqual([
          "robotics",
          "robotics",
        ]);
      })
  );

  it.effect(
    "a company listing keeps the first page of rows and counts the rest",
    () =>
      Effect.gen(function* cappedCompany() {
        const jobs = Array.from({ length: 30 }, (_, index) =>
          jobFrom("Ashby", `ashby:acme/${index}`)
        );

        const listing = yield* collectListing(
          (query) => Effect.succeed(pageOf(jobs, query)),
          Route.Company({ slug: "acme-robotics" })
        );

        expect(listing.jobs).toHaveLength(LISTING_ROWS);
        expect(listing.total).toBe(30);
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
            limit: LISTING_ROWS,
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
