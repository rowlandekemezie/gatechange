import { describe, expect, it } from "@effect/vitest";
import { SITE_NAME, SOURCE_REPOSITORY_URL } from "@rat-stack/core/contracts";
import type {
  JobDetailValue,
  JobPageValue,
  TrackedJobValue,
  JobQueryValue,
  JobValue,
  ListedJobValue,
  SourceNameValue,
} from "@rat-stack/core/contracts";
import { DateTime, Effect, Option, Schema } from "effect";
import { renderToString } from "foldkit/experimental/server";
import { fromString } from "foldkit/url";

import indexHtml from "../index.html?raw";
import manifestJson from "../public/manifest.webmanifest?raw";
import { application } from "../src/client/application.js";
import { defaultFilters } from "../src/client/board/filters.js";
import {
  Flags,
  ImportOffer,
  JobsState,
  Preload,
  TrackerState,
} from "../src/client/board/model.js";
import type {
  MarkedJobValue,
  PreloadValue,
} from "../src/client/board/model.js";
import { init } from "../src/client/board/update.js";
import { brandedTitle } from "../src/client/board/view.js";
import { collectListing, LISTING_ROWS } from "../src/client/listing.js";
import {
  boardUrl,
  companyRouter,
  jobRouter,
  roleRouter,
  Route,
  routeOfUrl,
} from "../src/client/route.js";
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
  enrichment: null,
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
  status: "on_time",
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

const renderJob = (job: JobDetailValue, policy: MarkupPolicy) =>
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

const SITE = "https://gatechange.dev";

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
          "<title>Director of Engineering at Acme &lt;Robotics&gt; · Gate Change</title>"
        );
        expect(page.html).not.toContain("Refreshed every few hours");
        expect(page.html).toContain(
          `<link rel="canonical" href="${ORIGIN}${GREENHOUSE_PATH}"`
        );
        expect(page.html).toContain(
          '<meta property="og:title" content="Director of Engineering at Acme &lt;Robotics&gt; · Gate Change" />'
        );
        expect(page.html).toContain('href="/companies/acme-robotics"');
      })
  );

  it.effect(
    "shows the leadership facts in About the role and leaves out the ones the posting did not state",
    () =>
      Effect.map(
        renderJob(
          {
            ...greenhouse,
            enrichment: {
              board: null,
              enrichedAt: 1_760_000_000_000,
              handsOn: "Some",
              model: "test-model",
              promptVersion: 2,
              remotePolicy: null,
              reportsTo: "VP of Engineering",
              salary: null,
              seniority: null,
              teamSize: 24,
            },
          },
          allowedOnly
        ),
        ({ html }) => {
          const text = textOf(html).replaceAll(/\s+/gu, " ");

          expect(text).toContain("About the role");
          expect(text).toContain("Team size 24 people");
          expect(text).toContain("Reports to VP of Engineering");
          expect(text).toContain("Hands-on coding Part of the job");
          expect(text).not.toContain("Remote policy");
        }
      )
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

  it.effect(
    "declares the Open Graph type and a large image card with an absolute image URL",
    () =>
      Effect.map(renderJob(greenhouse, allowedOnly), ({ html }) => {
        expect(html).toContain('<meta property="og:type" content="website" />');
        expect(html).toContain(
          '<meta property="og:site_name" content="Gate Change" />'
        );
        expect(html).toContain(
          `<meta property="og:image" content="${ORIGIN}/og.png" />`
        );
        expect(html).toContain(
          '<meta property="og:image:width" content="1200" />'
        );
        expect(html).toContain(
          '<meta property="og:image:height" content="630" />'
        );
        expect(html).toMatch(
          /<meta property="og:image:alt" content="[^"]+" \/>/u
        );
        expect(html).toContain(
          '<meta name="twitter:card" content="summary_large_image" />'
        );
        expect(html).toContain(
          `<meta name="twitter:image" content="${ORIGIN}/og.png" />`
        );
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
          '<meta property="og:title" content="Director of Engineering at Acme&quot; onload=&quot;alert(1) · Gate Change" />'
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
          "<title>Lead $` ops at Cash $&amp; Carry $' · Gate Change</title>"
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

const FLAGS_PAYLOAD =
  /<script type="application\/json" data-foldkit-flags="[^"]*">(?<flags>.*?)<\/script>/su;

describe("public landing hydration", () => {
  it.effect(
    "hands the public board snapshot and URL filters to client init without a second listing fetch",
    () =>
      Effect.gen(function* boardHydration() {
        const filters = {
          ...defaultFilters,
          roles: ["Director"] as const,
          search: "Acme </script><script>",
        };

        const path = boardUrl(filters);

        const preload = Preload.Board({
          filters,
          generatedAt: 1_760_500_000_000,
          jobs: [acmeDirector],
          stats: null,
          total: 45,
        });

        const { html, status } = yield* render(path, preload);

        const match = Option.getOrThrow(
          Option.fromNullishOr(FLAGS_PAYLOAD.exec(html))
        );

        const flags = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Flags)
        )(match.groups?.flags);

        const started = init(
          flags,
          Option.getOrThrow(fromString(`${ORIGIN}${path}`))
        );

        expect(status).toBe(200);
        expect(html).toContain("Director of Engineering");
        expect(html).toContain('content="noindex"');
        expect(html).not.toContain("</script><script>");
        expect(html).toContain(`href="${jobRouter({ id: acmeDirector.id })}"`);
        expect(started.model.filters).toStrictEqual(filters);
        expect(started.model.draftSearch).toBe(filters.search);
        expect(started.model.jobs).toStrictEqual(
          JobsState.Loaded({
            generatedAt: 1_760_500_000_000,
            jobs: [acmeDirector],
            total: 45,
          })
        );
        expect(started.commands?.map((command) => command.name)).not.toContain(
          "FetchJobs"
        );
        expect(started.model.marks).toStrictEqual([]);
        expect(started.model.account.session._tag).not.toBe("SignedIn");
      })
  );

  it("rejects a board snapshot belonging to different URL filters", () => {
    const started = init(
      {
        origin: ORIGIN,
        preload: Preload.Board({
          filters: defaultFilters,
          generatedAt: 0,
          jobs: [acmeDirector],
          stats: null,
          total: 1,
        }),
      },
      Option.getOrThrow(fromString(`${ORIGIN}/?q=different`))
    );

    expect(started.model.filters.search).toBe("different");
    expect(started.model.jobs._tag).toBe("Loading");
    expect(started.commands?.map((command) => command.name)).toContain(
      "FetchJobs"
    );
  });

  it.effect(
    "renders pricing metadata and public plan copy without a job preload",
    () =>
      Effect.map(render("/pricing", Preload.Nothing()), (page) => {
        expect(page.status).toBe(200);
        expect(page.html).toContain("<title>Pro plans · Gate Change</title>");
        expect(page.html).toContain("Pro for engineering leaders");
        expect(page.html).toContain(
          "Every engineering leadership listing stays free"
        );
        expect(page.html).toContain(
          `<link rel="canonical" href="${ORIGIN}/pricing"`
        );
      })
  );
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
          summary: null,
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
          summary: null,
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
          expect(textOf(html)).toContain(acmeDirector.title);
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
          summary: null,
          total: 2,
        })
      ),
      ({ html, status }) => {
        expect(status).toBe(200);
        expect(html).toContain(
          "<title>Engineering leadership roles at Acme &lt;Robotics&gt; · Gate Change</title>"
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
          summary: null,
          total: 30,
        })
      ),
      ({ html, status }) => {
        expect(status).toBe(200);
        expect(html).toContain(
          "<title>Director roles remote in Canada · Gate Change</title>"
        );
        expect(html).toContain(
          `<link rel="canonical" href="${ORIGIN}/roles/director/remote-canada"`
        );
        expect(html).toContain('href="/jobs/Z3JlZW5ob3VzZTphY21lLzE"');
        expect(textOf(html)).toContain("30 roles match");
        expect(html).toContain(
          'href="/?age=3650&amp;place=remote-canada&amp;role=director"'
        );
        expect(textOf(html)).toContain("See all 30 on the board");
      }
    )
  );

  it.effect("an empty listing answers 404 with a link back to the board", () =>
    Effect.map(
      render(
        "/companies/gone-co",
        Preload.Listing({
          generatedAt: 1_760_500_000_000,
          jobs: [],
          summary: null,
          total: 0,
        })
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
  it.effect.each(["remote", "e-1", "acme-robotics"])(
    "a company listing asks once for its exact slug %s without text-search paging",
    (slug) =>
      Effect.gen(function* exactCompany() {
        const calls: string[] = [];
        const target = jobFrom("Ashby", "remote:1", { company: "Remote" });

        const expected = {
          generatedAt: 1_760_500_000_000,
          jobs: slug === "remote" ? [target] : [],
          summary: { longestOpenDays: 0, openRoles: slug === "remote" ? 1 : 0 },
          total: slug === "remote" ? 1 : 0,
        };

        const listing = yield* collectListing(
          {
            companyJobs: (key) => {
              calls.push(key);

              return Effect.succeed(expected);
            },
            listJobs: () =>
              Effect.die("company pages must not search all listings"),
          },
          Route.Company({ slug })
        );

        expect(calls).toStrictEqual([slug]);
        expect(listing).toStrictEqual(expected);
      })
  );

  it.effect(
    "a company listing preserves the full summary beyond the displayed rows",
    () =>
      Effect.gen(function* summaryCounts() {
        const expected = {
          generatedAt: 1_760_500_000_000,
          jobs: Array.from({ length: LISTING_ROWS }, (_, index) =>
            jobFrom("Ashby", `acme:${index}`)
          ),
          summary: { longestOpenDays: 29, openRoles: 600 },
          total: 600,
        };

        const listing = yield* collectListing(
          {
            companyJobs: () => Effect.succeed(expected),
            listJobs: () => Effect.die("unused"),
          },
          Route.Company({ slug: "acme-robotics" })
        );

        expect(listing).toStrictEqual(expected);
      })
  );

  it.effect(
    "a role listing asks for that role in every region of its place",
    () =>
      Effect.gen(function* roleListing() {
        const queries: JobQueryValue[] = [];
        yield* collectListing(
          {
            companyJobs: () =>
              Effect.die("role pages must not look up a company"),
            listJobs: (query) => {
              queries.push(query);

              return Effect.succeed(pageOf([], query));
            },
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

const isoOf = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

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
  it("dates each URL by its newest listing's first sighting, not by re-sightings", () => {
    const newer = jobFrom("Lever", "lever:acme/2", {
      firstSeenAt: greenhouse.firstSeenAt + 3_600_000,
    });

    const xml = sitemapXml(ORIGIN, [greenhouse, newer]);

    const resighted = sitemapXml(ORIGIN, [
      { ...greenhouse, lastSeenAt: greenhouse.lastSeenAt + 86_400_000 },
      newer,
    ]);

    const entryOf = (path: string) =>
      xml.split("\n").find((line) => line.includes(`${ORIGIN}${path}</loc>`));

    expect(resighted).toBe(xml);
    expect(entryOf(jobRouter({ id: greenhouse.id }))).toContain(
      `<lastmod>${isoOf(greenhouse.firstSeenAt)}</lastmod>`
    );
    expect(entryOf("/companies/acme-robotics")).toContain(
      `<lastmod>${isoOf(newer.firstSeenAt)}</lastmod>`
    );
    expect(
      entryOf(roleRouter({ place: "RemoteCanada", role: "Director" }))
    ).toContain(`<lastmod>${isoOf(newer.firstSeenAt)}</lastmod>`);
    expect(entryOf("/pricing")).not.toContain("<lastmod>");
    expect(entryOf("/about")).not.toContain("<lastmod>");
  });

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
      Route.Pricing(),
      ...(["About", "Privacy", "Terms", "Contact"] as const).map((page) =>
        Route.Information({ page })
      ),
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

describe("site header", () => {
  it.effect.each(["/", "/pricing", "/shortlist", "/about"])(
    "names the site and reaches every section from %s",
    (path) =>
      Effect.map(render(path, Preload.Nothing()), ({ html }) => {
        const header = html.slice(
          html.indexOf('<header class="site-header"'),
          html.indexOf("</header>")
        );

        const footer = html.slice(html.indexOf('<footer class="footer"'));

        expect(header).toContain(SITE_NAME);
        expect(header).toContain('href="/#agents"');
        expect(header).not.toContain(`href="${SOURCE_REPOSITORY_URL}"`);
        expect(footer).not.toContain('href="/#agents"');
        expect(footer).toContain(`href="${SOURCE_REPOSITORY_URL}"`);
        expect(textOf(header)).toContain("Shortlist (0)");
        expect(textOf(header)).toContain("Sign in");
      })
  );

  it.effect("marks the current page in the site navigation", () =>
    Effect.map(render("/shortlist", Preload.Nothing()), ({ html }) => {
      expect(html).toContain(
        '<a aria-current="page" class="nav-link" href="/shortlist"'
      );
      expect(html).not.toContain(
        '<a aria-current="page" class="nav-link" href="/"'
      );
    })
  );

  it.effect("gives the For agents link a target on the board", () =>
    Effect.map(render("/", Preload.Nothing()), ({ html }) => {
      expect(html).toMatch(/<section [^>]*id="agents"/u);
    })
  );
});

const homeGeneratedAt = 1_760_500_000_000;

const homeBoard = Preload.Board({
  filters: defaultFilters,
  generatedAt: homeGeneratedAt,
  jobs: [acmeDirector],
  stats: null,
  total: 45,
});

const boardStats = {
  activeJobs: 4,
  companies: [{ company: "Acme <Robotics>", count: 3, slug: "acme-robotics" }],
  feedsFailing: 0,
  feedsTotal: 1,
  generatedAt: 1_760_500_000_000,
  lastRun: null,
  newToday: 1,
  placements: [
    {
      count: 3,
      region: "RemoteNorthAmerica" as const,
      role: "Director" as const,
    },
    { count: 2, region: "Elsewhere" as const, role: "Director" as const },
    {
      count: 1,
      region: "BritishColumbia" as const,
      role: "VicePresident" as const,
    },
  ],
  regions: [],
  roles: [],
};

describe("the New badge on a listing row", () => {
  const DAY = 86_400_000;
  const FRESH_BADGE = `class="fresh"`;
  const arrivedAt = homeGeneratedAt - DAY / 2;

  const row = (postedAt: number) =>
    Preload.Listing({
      generatedAt: homeGeneratedAt,
      jobs: [
        jobFrom("Greenhouse", "greenhouse:acme/new", {
          firstSeenAt: arrivedAt,
          postedAt,
        }),
      ],
      summary: null,
      total: 1,
    });

  it.effect("marks a role first seen today that was posted recently", () =>
    Effect.map(
      render("/companies/acme-robotics", row(arrivedAt - DAY)),
      ({ html }) => {
        expect(html).toContain(FRESH_BADGE);
      }
    )
  );

  it.effect("leaves it off a role that arrived long open", () =>
    Effect.map(
      render("/companies/acme-robotics", row(arrivedAt - 31 * DAY)),
      ({ html }) => {
        expect(html).not.toContain(FRESH_BADGE);
      }
    )
  );
});

describe("internal links", () => {
  it.effect(
    "links every open role hub and the busiest companies from the home page",
    () =>
      Effect.map(
        render("/", { ...homeBoard, stats: boardStats }),
        ({ html }) => {
          const start = html.indexOf('id="browse-title"');
          const browse = html.slice(start, html.indexOf("</nav>", start));

          const hrefs = [...browse.matchAll(HREF)].map(
            (match) => match.groups?.href
          );

          expect(hrefs).toStrictEqual([
            roleRouter({ place: "BritishColumbia", role: "VicePresident" }),
            roleRouter({ place: "RemoteCanada", role: "Director" }),
            roleRouter({ place: "RemoteUnitedStates", role: "Director" }),
            companyRouter({ slug: "acme-robotics" }),
          ]);
          expect(textOf(browse)).toContain("Director roles remote in the US");
          expect(textOf(browse)).toContain("Acme &lt;Robotics&gt;");
        }
      )
  );

  it.effect("renders no browse section when board stats are unavailable", () =>
    Effect.map(render("/", homeBoard), ({ html }) => {
      expect(html).not.toContain('id="browse-title"');
    })
  );

  it.effect("links a job page to its company and its role hubs", () =>
    Effect.map(
      render(
        GREENHOUSE_PATH,
        Preload.Job({
          job: { ...greenhouse, region: "RemoteNorthAmerica" },
        })
      ),
      ({ html }) => {
        const more = html.slice(html.indexOf('class="detail-more"'));

        expect(more).toContain(
          `href="${companyRouter({ slug: "acme-robotics" })}">More at Acme &lt;Robotics&gt;</a>`
        );
        expect(more).toContain(
          `href="${roleRouter({ place: "RemoteCanada", role: "Director" })}">Director roles remote in Canada</a>`
        );
        expect(more).toContain(
          `href="${roleRouter({ place: "RemoteUnitedStates", role: "Director" })}">Director roles remote in the US</a>`
        );
        expect(more).not.toContain("on-site in the US");
      }
    )
  );

  it.effect.each(["/", "/about", GREENHOUSE_PATH])(
    "links the remote US role hubs from the footer on %s",
    (path) =>
      Effect.map(render(path, Preload.Nothing()), ({ html }) => {
        const footer = html.slice(html.indexOf('<footer class="footer"'));

        expect(footer).toContain(
          `href="${roleRouter({ place: "RemoteUnitedStates", role: "VicePresident" })}"`
        );
        expect(footer).toContain(
          `href="${roleRouter({ place: "RemoteUnitedStates", role: "EngineeringManager" })}"`
        );
      })
  );
});

describe("home page render", () => {
  it.effect(
    "leads with one headline and ends with agent and source links",
    () =>
      Effect.map(render("/", Preload.Nothing()), ({ html }) => {
        expect(html.match(/<h1[\s>]/gu)).toHaveLength(1);
        expect(html).toMatch(/<h1[^>]*>Your next move is on the board.<\/h1>/u);
        expect(html).toContain(
          `claude mcp add --transport http gate-change ${ORIGIN}/mcp`
        );
        expect(html).toContain(
          'href="https://github.com/rowlandekemezie/jobs"'
        );
      })
  );
});

describe("home filters", () => {
  it.effect("keep every filter in the panel the Filters button controls", () =>
    Effect.map(render("/", homeBoard), ({ html }) => {
      const toggle = /<button[^>]*filters-toggle.*?<\/button>/su.exec(
        html
      )?.[0];

      expect(toggle).toContain('aria-controls="filter-panel"');
      expect(toggle).toContain('aria-expanded="false"');
      expect(textOf(toggle ?? "")).toContain("4 roles, 3 places, last week");

      const panel = html.slice(
        html.indexOf('id="filter-panel"'),
        html.indexOf('class="count"')
      );

      expect(panel).toContain("remote in Canada");
      expect(panel).toContain("Salary and seniority");
      expect(panel).toContain("Sign in to get new matches by email");
    })
  );

  it.effect("say how fresh the board is when nothing matches", () =>
    Effect.map(
      render(
        "/",
        Preload.Board({
          filters: defaultFilters,
          generatedAt: 1_760_500_000_000,
          jobs: [],
          stats: boardStats,
          total: 0,
        })
      ),
      ({ html }) => {
        expect(html).toContain("No roles match that sentence yet.");
        expect(html).toContain('class="status"');
        expect(html).toContain("The first refresh has not run yet.");
      }
    )
  );

  it.effect("name a Pro selection while the panel is closed", () =>
    Effect.map(render("/?pay=200000", Preload.Nothing()), ({ html }) => {
      expect(html).toContain("last week, Pro filters");
    })
  );
});

describe("job page", () => {
  it.effect("puts Apply before the facts and names each fact once", () =>
    Effect.map(renderJob(greenhouse, allowedOnly), ({ html }) => {
      const facts = html.slice(html.indexOf('class="detail-facts"'));

      expect(html.indexOf('class="apply"')).toBeLessThan(
        html.indexOf('class="detail-facts"')
      );
      expect(textOf(facts)).not.toContain("Source");
    })
  );

  it.effect("leaves out Where when the region is all it would say", () =>
    Effect.map(
      renderJob({ ...greenhouse, location: "" }, allowedOnly),
      ({ html }) => {
        const facts = html.slice(html.indexOf('class="detail-facts"'));

        expect(textOf(facts)).toContain("Region");
        expect(textOf(facts)).not.toContain("Where");
      }
    )
  );
});

const SiteGraphProbe = Schema.fromJsonString(
  Schema.Struct({
    "@graph": Schema.Tuple([
      Schema.Struct({
        "@type": Schema.Literal("WebSite"),
        name: Schema.String,
        potentialAction: Schema.Struct({
          "@type": Schema.Literal("SearchAction"),
          target: Schema.Struct({ urlTemplate: Schema.String }),
        }),
        url: Schema.String,
      }),
      Schema.Struct({
        "@type": Schema.Literal("Organization"),
        logo: Schema.String,
        name: Schema.String,
        url: Schema.String,
      }),
    ]),
  })
);

const siteGraphIn = (html: string) =>
  Option.map(Option.fromNullishOr(JSON_LD.exec(html)), (match) =>
    Schema.decodeUnknownSync(SiteGraphProbe)(match.groups?.json)
  );

const ManifestProbe = Schema.fromJsonString(
  Schema.Struct({
    display: Schema.String,
    icons: Schema.Array(
      Schema.Struct({
        purpose: Schema.String,
        sizes: Schema.String,
        src: Schema.String,
      })
    ),
    name: Schema.String,
    start_url: Schema.String,
    theme_color: Schema.String,
  })
);

const publicFiles = new Set(
  Object.keys(import.meta.glob("../public/*")).map((file) =>
    file.replace("../public", "")
  )
);

describe("share and install metadata", () => {
  it.effect(
    "brands the home title once and describes the site and its owner",
    () =>
      Effect.map(render("/", homeBoard), ({ html }) => {
        expect(html).toContain(
          `<title>45 engineering leadership roles · ${SITE_NAME}</title>`
        );
        expect(html).not.toContain(`${SITE_NAME} · ${SITE_NAME}`);

        const [website, organization] = Option.getOrThrow(siteGraphIn(html))[
          "@graph"
        ];

        expect(website.name).toBe(SITE_NAME);
        expect(website.url).toBe(`${ORIGIN}/`);
        expect(organization.name).toBe(SITE_NAME);
        expect(organization.url).toBe(`${ORIGIN}/`);
        expect(publicFiles).toContain(new URL(organization.logo).pathname);
      })
  );

  it.effect(
    "points the search action at a board search for the typed words",
    () =>
      Effect.map(render("/", homeBoard), ({ html }) => {
        const [website] = Option.getOrThrow(siteGraphIn(html))["@graph"];

        const searched = new URL(
          website.potentialAction.target.urlTemplate.replace(
            "{search_term_string}",
            "platform"
          )
        );

        const route = routeAt(`${searched.pathname}${searched.search}`);

        expect(searched.origin).toBe(ORIGIN);
        expect(Schema.is(Route.Board)(route) && route.filters.search).toBe(
          "platform"
        );
      })
  );

  it.effect.each(["/pricing", "/about"])(
    "keeps the site graph off %s but still shares the card image",
    (path) =>
      Effect.map(render(path, Preload.Nothing()), ({ html }) => {
        expect(html).not.toContain('"WebSite"');
        expect(html).toContain(
          `<meta property="og:image" content="${ORIGIN}/og.png" />`
        );
      })
  );

  it("keeps a title that already carries the brand as it is", () => {
    expect(brandedTitle(SITE_NAME)).toBe(SITE_NAME);
    expect(brandedTitle(`Pro plans · ${SITE_NAME}`)).toBe(
      `Pro plans · ${SITE_NAME}`
    );
  });

  it("links every icon and the manifest from the shell, and each one ships", () => {
    const linked = Array.from(
      indexHtml.matchAll(
        /<link rel="(?:icon|apple-touch-icon|manifest)" href="(?<href>[^"]+)"/gu
      ),
      (match) => match.groups?.href
    );

    expect(linked).toStrictEqual([
      "/favicon.ico",
      "/favicon.svg",
      "/apple-touch-icon.png",
      "/manifest.webmanifest",
    ]);
    expect(linked.filter((href) => !publicFiles.has(href ?? ""))).toStrictEqual(
      []
    );
    expect(publicFiles).toContain("/og.png");
    expect(indexHtml).toContain("viewport-fit=cover");
  });

  it("installs under the site name from the root with a maskable icon", () => {
    const manifest = Schema.decodeUnknownSync(ManifestProbe)(manifestJson);

    expect(manifest.name).toBe(SITE_NAME);
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color.toLowerCase()).toBe("#f4f3ef");
    expect(manifest.icons.map((icon) => icon.purpose)).toContain("maskable");
    expect(
      manifest.icons.filter((icon) => !publicFiles.has(icon.src))
    ).toStrictEqual([]);
  });
});
