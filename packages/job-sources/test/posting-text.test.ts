import { describe, expect, it } from "@effect/vitest";
import { moneyRangesIn, PostingGone, PostingTexts } from "@rat-stack/core";
import type { JobValue } from "@rat-stack/core";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { postingTextsLayer } from "../src/index.js";
import ashbyFixture from "./fixtures/ashby-board.json" with { type: "json" };
import greenhouseFixture from "./fixtures/greenhouse-job.json" with { type: "json" };
import leverFixture from "./fixtures/lever-posting.json" with { type: "json" };
import smartRecruitersFixture from "./fixtures/smartrecruiters-posting.json" with { type: "json" };
import workableFixture from "./fixtures/workable-job.json" with { type: "json" };

const greenhouseJob = JSON.stringify(greenhouseFixture);

const leverPosting = JSON.stringify(leverFixture);

const ashbyBoard = JSON.stringify(ashbyFixture);

const smartRecruitersPosting = JSON.stringify(smartRecruitersFixture);

const workableJob = JSON.stringify(workableFixture);

const serving = (body: string, status = 200) => {
  const requested: string[] = [];

  const client = HttpClient.make((request) => {
    requested.push(request.url);

    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          headers: { "content-type": "application/json" },
          status,
        })
      )
    );
  });

  return {
    layer: postingTextsLayer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
    ),
    requested,
  };
};

const jobWithId = (id: string): JobValue => ({
  arrangement: "Remote",
  company: "Acme",
  feed: id.split(":").slice(0, 2).join(":"),
  firstSeenAt: 1_760_000_000_000,
  id,
  lastSeenAt: 1_760_000_000_000,
  location: "Remote",
  postedAt: 1_760_000_000_000,
  region: "RemoteGlobal",
  relevance: 1,
  role: "EngineeringManager",
  salary: null,
  source: "Greenhouse",
  title: "Engineering Manager",
  url: "https://example.com/job",
});

const fetchText = Effect.fnUntraced(function* fetchText(id: string) {
  const texts = yield* PostingTexts;

  return yield* texts.fetch(jobWithId(id));
});

describe("posting texts", () => {
  it.effect(
    "a Greenhouse posting decodes its escaped HTML into plain text",
    () => {
      const server = serving(greenhouseJob);

      return Effect.gen(function* readGreenhouse() {
        const text = yield* fetchText("greenhouse:vercel:6136160004");

        expect(server.requested).toStrictEqual([
          "https://boards-api.greenhouse.io/v1/boards/vercel/jobs/6136160004",
        ]);
        expect(text.startsWith("About Vercel:\nVercel is the agentic")).toBe(
          true
        );
        expect(text).toContain("we've helped builders");
        expect(text).not.toMatch(/[<>]|&[a-z#0-9]+;/u);
      }).pipe(Effect.provide(server.layer));
    }
  );

  it.effect(
    "a Greenhouse posting keeps each paragraph and list item on its own line",
    () => {
      const server = serving(
        JSON.stringify({
          content:
            "&lt;p&gt;Location: Southeast US&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Reports to: Senior Director, Deployment &amp;amp; Mission Engineering&lt;/li&gt;&lt;li&gt;10+ years leading &lt;strong&gt;field&lt;/strong&gt; teams&lt;br&gt;in public safety&lt;/li&gt;&lt;/ul&gt;",
        })
      );

      return Effect.gen(function* readGreenhouseLines() {
        const text = yield* fetchText("greenhouse:axon:8010142003");

        expect(text).toBe(
          "Location: Southeast US\nReports to: Senior Director, Deployment & Mission Engineering\n10+ years leading field teams\nin public safety"
        );
      }).pipe(Effect.provide(server.layer));
    }
  );

  it.effect(
    "a Lever posting joins its description, lists, additional text, salary and workplace type",
    () => {
      const server = serving(leverPosting);

      return Effect.gen(function* readLever() {
        const text = yield* fetchText(
          "lever:outreach:5becd4e1-3474-4f36-b5dd-4b2cd0eb1179"
        );

        expect(server.requested).toStrictEqual([
          "https://api.lever.co/v0/postings/outreach/5becd4e1-3474-4f36-b5dd-4b2cd0eb1179",
        ]);
        expect(text.startsWith("About Outreach")).toBe(true);
        expect(text).toContain("Your Daily Adventures Will Include:");
        expect(text).toContain(
          "Run Daily Advocacy Operations: Own the day-to-day operations"
        );
        expect(text).toContain("Why You’ll Love It Here");
        expect(text).toContain("$70,000-$110,000 USD");
        expect(text.endsWith("Workplace type: remote")).toBe(true);
        expect(text).not.toContain("<li>");
        expect(moneyRangesIn(text)).toContainEqual({
          amounts: [70_000, 110_000],
          currency: "USD",
          period: "Year",
        });
      }).pipe(Effect.provide(server.layer));
    }
  );

  it.effect.each([
    ["per-year-salary", "per year", "Year"],
    ["per-hour-wage", "per hour", "Hour"],
  ] as const)(
    "a Lever posting whose salary is only in its %s salary range states that range",
    ([interval, written, period]) => {
      const server = serving(
        JSON.stringify({
          descriptionPlain: "Lead the fleet infrastructure team.",
          salaryDescriptionPlain:
            "The listed range applies only to the base salary.",
          salaryRange: {
            currency: "USD",
            interval,
            max: 200_000,
            min: 167_000,
          },
        })
      );

      return Effect.gen(function* readLeverRange() {
        const text = yield* fetchText(
          "lever:zoox:48a7c3a9-3d0a-4b15-8a18-5ed786298316"
        );

        expect(text).toContain(
          `Salary range: 167,000 - 200,000 USD ${written}`
        );
        expect(moneyRangesIn(text)).toStrictEqual([
          { amounts: [167_000, 200_000], currency: "USD", period },
        ]);
      }).pipe(Effect.provide(server.layer));
    }
  );

  it.effect(
    "an Ashby posting is picked from its board with the compensation summary, location and workplace type",
    () => {
      const server = serving(ashbyBoard);

      return Effect.gen(function* readAshby() {
        const text = yield* fetchText(
          "ashby:clickup:abcd8589-5341-4890-99bb-3dcfc93246a9"
        );

        expect(server.requested).toStrictEqual([
          "https://api.ashbyhq.com/posting-api/job-board/clickup?includeCompensation=true",
        ]);
        expect(text.startsWith("At ClickUp, we're building")).toBe(true);
        expect(text).toContain("Come join the Hierarchy Squad");
        expect(text).toContain("please contact us at AskPeople@ClickUp.com.");
        expect(
          text.endsWith(
            "Compensation: $200K – $250K USD per 1 YEAR\n\nLocation: United States\n\nWorkplace type: Remote"
          )
        ).toBe(true);
        expect(moneyRangesIn(text)).toContainEqual({
          amounts: [200_000, 250_000],
          currency: "USD",
          period: "Year",
        });
      }).pipe(Effect.provide(server.layer));
    }
  );

  it.effect(
    "a Greenhouse pay range written with dash, currency and numeric entities reads as one band",
    () =>
      Effect.gen(function* readEscapedRange() {
        const text = yield* fetchText("greenhouse:axon:1");

        expect(text).toBe(
          "Base Pay Range $130,650 — $209,040 USD\nGross €60,000 – €75,000 per year\n$90,000 — $110,000\n&#99999999;"
        );
        expect(moneyRangesIn(text)).toStrictEqual([
          { amounts: [130_650, 209_040], currency: "USD", period: "Year" },
          { amounts: [60_000, 75_000], currency: "EUR", period: "Year" },
          { amounts: [90_000, 110_000], currency: "USD", period: "Year" },
        ]);
      }).pipe(
        Effect.provide(
          serving(
            JSON.stringify({
              content:
                "&lt;p&gt;Base Pay Range $130,650 &amp;mdash; $209,040 USD&lt;/p&gt;&lt;p&gt;Gross &amp;euro;60,000 &amp;ndash; &amp;euro;75,000 per year&lt;/p&gt;&lt;p&gt;&amp;#36;90,000 &amp;#x2014; &amp;#36;110,000&lt;/p&gt;&lt;p&gt;&amp;#99999999;&lt;/p&gt;",
            })
          ).layer
        )
      )
  );

  it.effect(
    "a Greenhouse posting ends with its board location, so a remote region there reaches the model",
    () =>
      Effect.gen(function* readGreenhouseLocation() {
        const text = yield* fetchText("greenhouse:mercury:1");

        expect(text).toBe(
          "Lead a team of 7+ engineers.\n\nLocation: San Francisco, CA, or Remote within Canada or United States"
        );
      }).pipe(
        Effect.provide(
          serving(
            JSON.stringify({
              content: "&lt;p&gt;Lead a team of 7+ engineers.&lt;/p&gt;",
              location: {
                name: "San Francisco, CA, or Remote within Canada or United States",
              },
            })
          ).layer
        )
      )
  );

  it.effect(
    "an Ashby hybrid posting flagged isRemote keeps its Hybrid workplace type",
    () =>
      Effect.gen(function* readAshbyHybrid() {
        const text = yield* fetchText("ashby:baseten:hybrid");

        expect(text).toBe("Inference team.\n\nWorkplace type: Hybrid");
      }).pipe(
        Effect.provide(
          serving(
            JSON.stringify({
              jobs: [
                {
                  descriptionPlain: "Inference team.",
                  id: "hybrid",
                  isRemote: true,
                  workplaceType: "Hybrid",
                },
              ],
            })
          ).layer
        )
      )
  );

  it.effect(
    "a SmartRecruiters posting joins its job ad sections as plain text",
    () => {
      const server = serving(smartRecruitersPosting);

      return Effect.gen(function* readSmartRecruiters() {
        const text = yield* fetchText(
          "smartrecruiters:ServiceNow:744000156092859"
        );

        expect(server.requested).toStrictEqual([
          "https://api.smartrecruiters.com/v1/companies/ServiceNow/postings/744000156092859",
        ]);
        expect(text.startsWith("Company Description")).toBe(true);
        expect(text).toContain("Sr Software Engineering Manager");
        expect(text).toContain("Qualifications");
        expect(text).not.toMatch(/[<>]|&[a-z#0-9]+;/u);
        expect(moneyRangesIn(text)).toContainEqual({
          amounts: [190_900, 334_100],
          currency: "USD",
          period: "Year",
        });
      }).pipe(Effect.provide(server.layer));
    }
  );

  it.effect(
    "a Workable job joins its description, requirements and benefits",
    () => {
      const server = serving(workableJob);

      return Effect.gen(function* readWorkable() {
        const text = yield* fetchText("workable:huggingface:81B46579FE");

        expect(server.requested).toStrictEqual([
          "https://apply.workable.com/api/v2/accounts/huggingface/jobs/81B46579FE",
        ]);
        expect(text.startsWith("At Hugging Face, we're on a journey")).toBe(
          true
        );
        expect(text).toContain("Please provide a cover letter");
        expect(text).not.toMatch(/[<>]|&[a-z#0-9]+;/u);
      }).pipe(Effect.provide(server.layer));
    }
  );

  it.effect("an Ashby posting missing from its board is gone", () =>
    Effect.gen(function* readMissingAshby() {
      const failure = yield* Effect.flip(fetchText("ashby:clickup:gone"));

      expect(failure).toStrictEqual(
        new PostingGone({
          id: "ashby:clickup:gone",
          message: "the posting is no longer on the Ashby board",
        })
      );
    }).pipe(Effect.provide(serving(ashbyBoard).layer))
  );

  it.effect.each([404, 410])(
    "a board that answers %i for the posting reports it gone",
    (status) =>
      Effect.gen(function* readRemovedPosting() {
        const failure = yield* Effect.flip(fetchText("greenhouse:vercel:1"));

        expect(failure._tag).toBe("PostingGone");
        expect(failure.id).toBe("greenhouse:vercel:1");
      }).pipe(Effect.provide(serving("{}", status).layer))
  );

  it.effect(
    "a board that refuses the request is unavailable, to retry later",
    () =>
      Effect.gen(function* readFailingBoard() {
        const failure = yield* Effect.flip(fetchText("greenhouse:vercel:1"));

        expect(failure._tag).toBe("PostingUnavailable");
        expect(failure.id).toBe("greenhouse:vercel:1");
      }).pipe(Effect.provide(serving("{}", 403).layer))
  );

  it.effect("a payload missing the posting text is unavailable", () =>
    Effect.gen(function* readEmptyPosting() {
      const failure = yield* Effect.flip(fetchText("greenhouse:vercel:1"));

      expect(failure._tag).toBe("PostingUnavailable");
    }).pipe(Effect.provide(serving(JSON.stringify({ id: 1 })).layer))
  );

  it.effect(
    "a posting with empty content is read as empty text for core to skip, not as unavailable",
    () =>
      Effect.gen(function* readBlankPosting() {
        const text = yield* fetchText("greenhouse:vercel:1");

        expect(text).toBe("");
      }).pipe(Effect.provide(serving(JSON.stringify({ content: "" })).layer))
  );

  it.effect(
    "an aggregator id or an unparseable id is gone without a request",
    () => {
      const server = serving(greenhouseJob);

      return Effect.gen(function* readUnsupported() {
        const aggregator = yield* Effect.flip(fetchText("remoteok:all:123"));
        const nonsense = yield* Effect.flip(fetchText("greenhouse-only"));

        expect(aggregator._tag).toBe("PostingGone");
        expect(nonsense._tag).toBe("PostingGone");
        expect(server.requested).toStrictEqual([]);
      }).pipe(Effect.provide(server.layer));
    }
  );
});
