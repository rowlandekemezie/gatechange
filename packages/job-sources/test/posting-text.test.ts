import { describe, expect, it } from "@effect/vitest";
import {
  detailsOfAnswer,
  moneyRangesIn,
  PostingGone,
  PostingTexts,
} from "@rat-stack/core";
import type { JobValue } from "@rat-stack/core";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { postingTextsLayer } from "../src/index.js";
import { linesOfHtml, MAX_HTML_CHARS, textOfHtml } from "../src/parse.js";
import ashbyFixture from "./fixtures/ashby-board.json" with { type: "json" };
import greenhouseFixture from "./fixtures/greenhouse-job.json" with { type: "json" };
import leverFixture from "./fixtures/lever-posting.json" with { type: "json" };
import workableFixture from "./fixtures/workable-job.json" with { type: "json" };

const greenhouseJob = JSON.stringify(greenhouseFixture);

const leverPosting = JSON.stringify(leverFixture);

const ashbyBoard = JSON.stringify(ashbyFixture);

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

const fetchPosting = Effect.fnUntraced(function* fetchPosting(id: string) {
  const texts = yield* PostingTexts;

  return yield* texts.fetch(jobWithId(id));
});

const unitedStates = (addressLocality: string, addressRegion: string) => ({
  addressCountry: "United States",
  addressLocality,
  addressRegion,
});

const salaryComponent = (
  interval: string,
  minValue: number,
  maxValue: number
) => ({
  compensationType: "Salary",
  currencyCode: "USD",
  interval,
  maxValue,
  minValue,
});

type Json =
  | boolean
  | number
  | string
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

interface AshbyJobFixture {
  readonly descriptionPlain?: string;
  readonly address?: Json;
  readonly compensation?: Json;
  readonly location?: string;
}

const readAshbyJob = (job: AshbyJobFixture) =>
  fetchPosting("ashby:plaid:job").pipe(
    Effect.provide(
      serving(
        JSON.stringify({
          jobs: [{ descriptionPlain: "Sell.", id: "job", ...job }],
        })
      ).layer
    )
  );

const labelledTier = (
  labels: Record<string, string | null>,
  components: readonly Json[] = []
) => ({
  compensation: {
    compensationTierSummary: "$143K – $193.2K",
    compensationTiers: [
      {
        additionalInformation: labels.additionalInformation ?? null,
        components: [
          ...components,
          {
            ...salaryComponent("1 YEAR", 143_000, 193_200),
            summary: labels.summary ?? "$143K – $193.2K",
          },
        ],
        title: labels.title ?? null,
      },
    ],
  },
});

const fetchText = (id: string) =>
  fetchPosting(id).pipe(Effect.map((posting) => posting.text));

describe("posting texts", () => {
  it.effect.each([
    ["conflicting bounds", "Base salary: USD 293,000 - 325,000 per year", true],
    [
      "conflicting currency",
      "Base salary: CAD 347,000 - 385,000 per year",
      true,
    ],
    ["matching bounds", "Base salary: USD 347,000 - 385,000 per year", false],
    [
      "matching monthly pay",
      "Base salary: USD 28,916.6667 - 32,083.3333 per month",
      false,
    ],
    [
      "selected regional band",
      "Base salary ranges:\nZone 1: USD 347,000 - 385,000\nZone 2: USD 293,000 - 325,000",
      false,
    ],
    ["no description salary", "Lead the team.", false],
    ["a distinct equity band", "Equity value: USD 293,000 - 325,000", false],
  ] as const)(
    "preserves salary uncertainty for %s",
    ([, descriptionPlain, uncertain]) =>
      Effect.gen(function* salarySources() {
        const posting = yield* readAshbyJob({
          compensation: {
            compensationTierSummary: "$347K - $385K",
            compensationTiers: [
              { components: [salaryComponent("1 YEAR", 347_000, 385_000)] },
            ],
          },
          descriptionPlain,
        });

        expect(posting.salaryUncertain === true).toBe(uncertain);

        const details = detailsOfAnswer(
          {
            handsOn: null,
            handsOnQuote: null,
            remotePolicy: null,
            remotePolicyQuote: null,
            reportsTo: null,
            reportsToQuote: null,
            salaryMax: 385_000,
            salaryMin: 347_000,
            seniority: null,
            teamSize: null,
            teamSizeQuote: null,
          },
          { ...posting, company: "Acme", title: "Engineering Manager" }
        );

        expect(details.salary).toStrictEqual(
          uncertain ? null : { currency: "USD", max: 385_000, min: 347_000 }
        );
      })
  );
  it.effect.each([
    "Software Engineering Intern",
    "Contract Engineering Manager",
    "Student Developer",
    "Engineering Contractor",
  ])("does not annualize hourly compensation for %s", (title) =>
    Effect.gen(function* hourlyPopulation() {
      const texts = yield* PostingTexts;

      const posting = yield* texts.fetch({
        ...jobWithId("ashby:acme:job"),
        title,
      });

      expect(posting.salary).toBeNull();
    }).pipe(
      Effect.provide(
        serving(
          JSON.stringify({
            jobs: [
              {
                compensation: {
                  compensationTiers: [
                    { components: [salaryComponent("1 HOUR", 62, 72)] },
                  ],
                },
                id: "job",
              },
            ],
          })
        ).layer
      )
    )
  );
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
    "a Greenhouse posting drops elements the page hides, so hidden text never reaches the model",
    () => {
      const server = serving(
        JSON.stringify({
          content:
            "&lt;p&gt;Base salary $150,000 - $180,000 per year.&lt;/p&gt;&lt;p style=&quot;display: none&quot;&gt;Base salary $400,000 - $500,000 per year.&lt;span&gt;nested&lt;/span&gt;&lt;/p&gt;&lt;div hidden&gt;&lt;div&gt;This role is fully remote.&lt;/div&gt;&lt;/div&gt;&lt;span style='visibility:hidden'&gt;Reports to the CEO&lt;/span&gt;&lt;script&gt;var pay = 1;&lt;/script&gt;&lt;p&gt;Hybrid, three days a week in the office.&lt;/p&gt;",
        })
      );

      return Effect.gen(function* readHidden() {
        const text = yield* fetchText("greenhouse:acme:1");

        expect(text).toBe(
          "Base salary $150,000 - $180,000 per year.\nHybrid, three days a week in the office."
        );
      }).pipe(Effect.provide(server.layer));
    }
  );

  it.effect(
    "a Lever posting joins its description, lists, additional text and salary, and carries its workplace type as a field",
    () => {
      const server = serving(leverPosting);

      return Effect.gen(function* readLever() {
        const { text, workplace } = yield* fetchPosting(
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
        expect(workplace).toBe("Remote");
        expect(text).not.toContain("Workplace type");
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
    "an Ashby posting is picked from its board with the compensation summary and location, and carries its workplace type as a field",
    () => {
      const server = serving(ashbyBoard);

      return Effect.gen(function* readAshby() {
        const { text, workplace } = yield* fetchPosting(
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
            "Compensation: $200K – $250K USD per 1 YEAR\n\nLocation: United States"
          )
        ).toBe(true);
        expect(workplace).toBe("Remote");
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
        const posting = yield* fetchPosting("ashby:baseten:hybrid");

        expect(posting).toStrictEqual({
          salary: null,
          text: "Inference team.",
          workplace: "Hybrid",
        });
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

  it.effect.each([
    [
      "a yearly salary tier",
      [{ components: [salaryComponent("1 YEAR", 200_000, 250_000)] }],
      { currency: "USD", max: 250_000, min: 200_000 },
    ],
    [
      "an hourly salary tier",
      [{ components: [salaryComponent("1 HOUR", 50, 60)] }],
      { currency: "USD", max: 124_800, min: 104_000 },
    ],
    [
      "a monthly salary tier",
      [{ components: [salaryComponent("1 MONTH", 12_000, 15_000)] }],
      { currency: "USD", max: 180_000, min: 144_000 },
    ],
    [
      "two tiers whose summary merges them",
      [
        {
          components: [
            { compensationType: "EquityPercentage", minValue: 0.1 },
            salaryComponent("1 YEAR", 240_000, 310_000),
          ],
          title: "Tier 1",
        },
        {
          components: [salaryComponent("1 YEAR", 210_000, 280_000)],
          title: "Tier 2",
        },
      ],
      { currency: "USD", max: 310_000, min: 240_000 },
    ],
    [
      "no salary component",
      [{ components: [{ compensationType: "EquityPercentage", minValue: 1 }] }],
      null,
    ],
    [
      "a salary with no max",
      [
        {
          components: [
            { ...salaryComponent("1 YEAR", 200_000, 0), maxValue: null },
          ],
        },
      ],
      null,
    ],
    [
      "an interval the board does not annualise",
      [{ components: [salaryComponent("1 WEEK", 60_000, 80_000)] }],
      null,
    ],
    ["malformed tiers", "not a list", null],
    ["no tiers", undefined, null],
  ] as const)(
    "an Ashby posting with %s carries its first tier's salary as its salary field and is still read",
    ([, compensationTiers, salary]) =>
      Effect.gen(function* readAshbySalary() {
        const posting = yield* fetchPosting("ashby:clickhouse:tiers");

        expect(posting.salary).toStrictEqual(salary);
        expect(posting.text).toBe(
          "Lead the database team.\n\nCompensation: $210K – $310K USD per 1 YEAR"
        );
      }).pipe(
        Effect.provide(
          serving(
            JSON.stringify({
              jobs: [
                {
                  compensation: {
                    compensationTierSummary: "$210K – $310K",
                    compensationTiers,
                    summaryComponents: [
                      salaryComponent("1 YEAR", 210_000, 310_000),
                    ],
                  },
                  descriptionPlain: "Lead the database team.",
                  id: "tiers",
                },
              ],
            })
          ).layer
        )
      )
  );

  it.effect.each([
    [
      "an On-Target Earnings summary",
      { summary: "On-Target Earnings $143K – $193.2K" },
    ],
    ["an OTE split summary", { summary: "OTE 75/25 Split $143K – $193.2K" }],
    ["an OTE note", { additionalInformation: "OTE 50/50" }],
    [
      "a tier title that calls the range OTE",
      {
        summary: "Base Salary Range $143K – $193.2K",
        title:
          "For candidates in the US, the Compensation Range below represents On-Target Earnings (OTE).",
      },
    ],
    [
      "a base plus commissions summary",
      { summary: "On Target Earnings (Base + Commissions) $143K – $193.2K" },
    ],
  ] as const)(
    "an Ashby salary component labelled as on-target pay by %s is no typed salary",
    ([, labels]) =>
      Effect.gen(function* readOteTier() {
        const posting = yield* readAshbyJob(labelledTier(labels));

        expect(posting.salary).toBeNull();
      })
  );

  it.effect.each([
    ["an unlabelled summary", {}],
    [
      "an Estimated Base Salary summary",
      { summary: "Estimated Base Salary $143K – $193.2K" },
    ],
    [
      "a base salary note that excludes commission",
      {
        summary:
          "The target base salary for this position excludes commission (if applicable), equity and benefits. The pay range shown is the target for new-hire salaries. $143K – $193.2K",
      },
    ],
  ] as const)(
    "an Ashby salary component with %s beside a commission component stays the typed salary",
    ([, labels]) =>
      Effect.gen(function* readBaseTier() {
        const posting = yield* readAshbyJob(
          labelledTier(labels, [
            {
              compensationType: "Commission",
              currencyCode: "USD",
              interval: "1 YEAR",
              maxValue: null,
              minValue: null,
              summary: "Offers Commission",
            },
          ])
        );

        expect(posting.salary).toStrictEqual({
          currency: "USD",
          max: 193_200,
          min: 143_000,
        });
      })
  );

  const cohereTiers = [
    {
      components: [
        {
          ...salaryComponent("1 YEAR", 295_000, 535_000),
          currencyCode: "CAD",
        },
      ],
      title: "Canada - Toronto (GTA), Montreal",
    },
    {
      components: [salaryComponent("1 YEAR", 205_000, 380_000)],
      title: "USA - California, New York and Washington",
    },
    {
      components: [salaryComponent("1 YEAR", 175_000, 325_000)],
      title: "USA - All Other States",
    },
  ];

  it.effect.each([
    [
      "Toronto",
      { addressCountry: "Canada", addressLocality: "Toronto" },
      { currency: "CAD", max: 535_000, min: 295_000 },
    ],
    [
      "San Francisco",
      {
        addressCountry: "United States",
        addressLocality: "San Francisco",
        addressRegion: "California",
      },
      { currency: "USD", max: 380_000, min: 205_000 },
    ],
    [
      "Austin",
      {
        addressCountry: "USA",
        addressLocality: "Austin",
        addressRegion: "Texas",
      },
      { currency: "USD", max: 380_000, min: 205_000 },
    ],
    [
      "London",
      { addressCountry: "United Kingdom", addressLocality: "London" },
      { currency: "CAD", max: 535_000, min: 295_000 },
    ],
    [
      "New York",
      "not an address",
      { currency: "USD", max: 380_000, min: 205_000 },
    ],
    [
      "United States",
      "not an address",
      { currency: "USD", max: 380_000, min: 205_000 },
    ],
  ] as const)(
    "an Ashby posting in %s takes the tier named for its location, else the first",
    ([location, postalAddress, salary]) =>
      Effect.gen(function* readLocatedTier() {
        const posting = yield* readAshbyJob({
          address: { postalAddress },
          compensation: { compensationTiers: cohereTiers },
          location,
        });

        expect(posting.salary).toStrictEqual(salary);
      })
  );

  const tier = (title: string, minValue: number, maxValue: number) => ({
    components: [salaryComponent("1 YEAR", minValue, maxValue)],
    title,
  });

  const writerTiers = [
    tier("SF & NYC", 204_000, 240_000),
    tier("Other US Locations", 183_000, 216_000),
  ];

  it.effect.each([
    [
      "San Francisco, CA",
      unitedStates("San Francisco", "California"),
      writerTiers,
      204_000,
    ],
    [
      "New York City, NY",
      unitedStates("New York City", "New York"),
      writerTiers,
      204_000,
    ],
    ["Denver, CO", unitedStates("Denver", "Colorado"), writerTiers, 204_000],
    [
      "Denver, Colorado",
      unitedStates("Denver", "Colorado"),
      [
        tier("SF & NYC", 204_000, 240_000),
        tier("Columbus and Austin", 170_000, 200_000),
      ],
      204_000,
    ],
    [
      "San Francisco",
      unitedStates("San Francisco", "California"),
      [
        tier("Remote (US)", 180_000, 210_000),
        tier("SF & NYC", 204_000, 240_000),
      ],
      204_000,
    ],
    [
      "SF",
      unitedStates("San Francisco", "California"),
      [
        tier("Outside SF and NYC", 183_000, 216_000),
        tier("SF and NYC", 204_000, 240_000),
      ],
      204_000,
    ],
    [
      "Austin, TX",
      {
        addressCountry: "US",
        addressLocality: "Austin",
        addressRegion: "Texas",
      },
      [
        tier("Tier 1 metros", 200_000, 250_000),
        tier("Non-US", 90_000, 110_000),
        tier("US other", 150_000, 180_000),
      ],
      200_000,
    ],
    [
      "Seattle, WA",
      unitedStates("Seattle", "Washington"),
      [
        tier("Tier 1: New York, San Francisco", 200_000, 250_000),
        tier("Washington DC", 190_000, 240_000),
        tier("Rest of US", 150_000, 180_000),
      ],
      200_000,
    ],
    [
      "Washington, DC",
      unitedStates("Washington", "District of Columbia"),
      [
        tier("Seattle, Washington", 210_000, 260_000),
        tier("DC Metro", 190_000, 240_000),
      ],
      190_000,
    ],
    [
      "London, Ontario",
      {
        addressCountry: "Canada",
        addressLocality: "London",
        addressRegion: "Ontario",
      },
      [
        tier("Toronto / Canada", 120_000, 150_000),
        tier("London", 90_000, 110_000),
      ],
      120_000,
    ],
    [
      "Atlanta, GA",
      unitedStates("Atlanta", "Georgia"),
      [
        tier("Tbilisi, Georgia", 40_000, 60_000),
        tier("United States", 150_000, 180_000),
      ],
      150_000,
    ],
    [
      "Tbilisi",
      {
        addressCountry: "Georgia",
        addressLocality: "Tbilisi",
        addressRegion: "",
      },
      [
        tier("United States", 150_000, 180_000),
        tier("Georgia", 40_000, 60_000),
      ],
      40_000,
    ],
  ] as const)(
    "an Ashby posting in %s takes no residual, negated or other-place tier",
    ([location, postalAddress, compensationTiers, min]) =>
      Effect.gen(function* readTierByPlace() {
        const posting = yield* readAshbyJob({
          address: { postalAddress },
          compensation: { compensationTiers },
          location,
        });

        expect(posting.salary?.min).toBe(min);
      })
  );

  it.effect.each([
    ["a numeric tier summary", { compensationTierSummary: 210_000 }],
    [
      "a summary component with a numeric type",
      {
        compensationTierSummary: "$210K – $310K",
        summaryComponents: [
          { compensationType: 7 },
          salaryComponent("1 YEAR", 210_000, 310_000),
        ],
      },
    ],
    ["a compensation string", "$210K"],
  ] as const)("an Ashby posting with %s is still read", ([, compensation]) =>
    Effect.gen(function* readMalformedCompensation() {
      const posting = yield* readAshbyJob({ compensation });

      expect(posting.text.startsWith("Sell.")).toBe(true);
    })
  );

  it.effect(
    "a SmartRecruiters listing left in the store is gone without a request",
    () => {
      const server = serving("{}");

      return Effect.gen(function* readRetiredBoard() {
        const failure = yield* Effect.flip(
          fetchText("smartrecruiters:Experian:744000156092859")
        );

        expect(failure._tag).toBe("PostingGone");
        expect(server.requested).toStrictEqual([]);
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

  it.effect.each([
    ["on_site", "Onsite"],
    ["hybrid", "Hybrid"],
    ["remote", "Remote"],
    [null, "Unspecified"],
  ] as const)(
    "a Workable job with workplace %j carries %s as its workplace type",
    ([workplace, expected]) =>
      Effect.gen(function* readWorkableWorkplace() {
        const posting = yield* fetchPosting("workable:upstream:0C4692F46C");

        expect(posting).toStrictEqual({
          salary: null,
          text: "Field engineer.",
          workplace: expected,
        });
      }).pipe(
        Effect.provide(
          serving(
            JSON.stringify({ description: "<p>Field engineer.</p>", workplace })
          ).layer
        )
      )
  );

  it.effect(
    "a Greenhouse posting has no workplace field, so a workplace line in its text stays text",
    () =>
      Effect.gen(function* readGreenhouseWorkplaceLine() {
        const posting = yield* fetchPosting("greenhouse:acme:2");

        expect(posting).toStrictEqual({
          salary: null,
          text: "Workplace type: Remote\nYou will work in our Austin office five days a week.",
          workplace: "Unspecified",
        });
      }).pipe(
        Effect.provide(
          serving(
            JSON.stringify({
              content:
                "&lt;p&gt;Workplace type: Remote&lt;/p&gt;&lt;p&gt;You will work in our Austin office five days a week.&lt;/p&gt;",
            })
          ).layer
        )
      )
  );

  it.effect(
    "a Lever posting longer than the model's character budget still carries its workplace type",
    () =>
      Effect.gen(function* readLongLever() {
        const posting = yield* fetchPosting("lever:acme:long");

        expect(posting.text.length).toBeGreaterThan(12_000);
        expect(posting.workplace).toBe("Onsite");
      }).pipe(
        Effect.provide(
          serving(
            JSON.stringify({
              descriptionPlain: `Workplace type: Remote\n${"We build tools for warehouses. ".repeat(500)}`,
              workplaceType: "onsite",
            })
          ).layer
        )
      )
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
        const posting = yield* fetchPosting("greenhouse:vercel:1");

        expect(posting).toStrictEqual({
          salary: null,
          text: "",
          workplace: "Unspecified",
        });
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

describe("linesOfHtml", () => {
  it.each([
    ["unclosed anchor tags", "<a".repeat(500_000)],
    ["unclosed paragraph tags", "<p".repeat(500_000)],
  ])("1 MB of %s parses in under 100 ms", (_label, html) => {
    const started = performance.now();

    linesOfHtml(html);

    expect(performance.now() - started).toBeLessThan(100);
  });

  it("1 MB of escaped unclosed tags in Greenhouse content parses in under 100 ms", () => {
    const started = performance.now();

    linesOfHtml(textOfHtml("&lt;a".repeat(250_000)));

    expect(performance.now() - started).toBeLessThan(100);
  });

  it("reads only the first 200,000 characters of raw HTML", () => {
    const text = linesOfHtml(
      `<p>${"word ".repeat(MAX_HTML_CHARS / 5)}</p><p>Base salary $400,000 - $500,000.</p>`
    );

    expect(MAX_HTML_CHARS).toBe(200_000);
    expect(text).not.toContain("Base salary");
  });

  it("drops text hidden by zero size, zero opacity, an unquoted style or a quoted font before display none", () => {
    expect(
      linesOfHtml(
        `<p>Shown.</p><p style="font-size:0">Base salary $400,000 - $500,000.</p><p style="opacity: 0">This role is fully remote.</p><p style=display:none>Reports to the CEO.</p><p style="font-family:'Arial';display:none">Lead a team of 40.</p><p style="font-size:14px;opacity:0.5">Visible.</p>`
      )
    ).toBe("Shown.\nVisible.");
  });

  it("a 200 KB unclosed tag whose name is word-hyphen pairs parses in under 100 ms", () => {
    const started = performance.now();

    linesOfHtml(`<p>Shown.</p><a${"-a".repeat(MAX_HTML_CHARS / 2 - 20)}`);

    expect(performance.now() - started).toBeLessThan(100);
  });

  it("a 200 KB opacity of zeros ending in 1 parses in under 50 ms and stays shown", () => {
    const zeros = "0".repeat(MAX_HTML_CHARS - 100);
    const started = performance.now();

    const text = linesOfHtml(`<span style="opacity:${zeros}1">Shown.</span>`);

    expect(performance.now() - started).toBeLessThan(50);
    expect(text).toBe("Shown.");
  });

  it.each([
    ["opacity:0", true],
    ["opacity: 0.0;", true],
    ["font-size:0px", true],
    ["font-size:0 !important", true],
    ["opacity:.0", true],
    ["opacity:00", true],
    ["opacity:0.5", false],
    ["font-size:01px", false],
  ])("style %j hides its element: %s", (style, hidden) => {
    expect(linesOfHtml(`<p>Shown.</p><p style="${style}">Styled.</p>`)).toBe(
      hidden ? "Shown." : "Shown.\nStyled."
    );
  });
});
