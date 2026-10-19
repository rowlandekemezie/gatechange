import { describe, expect, it } from "@effect/vitest";
import {
  Array,
  Clock,
  Data,
  Effect,
  Layer,
  Option,
  pipe,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import {
  AnnualAmount,
  DEFAULT_ENRICHMENT_SWEEP_LIMIT,
  detailsOfAnswer,
  EnricherUnavailable,
  EnrichmentOutcome,
  EnrichmentQueue,
  EnrichmentQueueUnavailable,
  enqueueUnenriched,
  enrichableSources,
  enrichListing,
  JobStore,
  ListingEnricher,
  listJobs,
  ModelAnswer,
  moneyRangesIn,
  PostingFeeds,
  PostingGone,
  PostingTexts,
  PostingUnavailable,
  runIngest,
  skipHandling,
  sweepLimitOf,
} from "../src/index.js";
import type {
  EnrichmentOutcomeValue,
  EnrichmentValue,
  FeedRef,
  JobQueryValue,
  JobStoreUnavailable,
  JobValue,
  ModelAnswerValue,
  PostingValue,
} from "../src/index.js";
import { makeMemoryJobStore } from "./memory-job-store.js";

const MODEL = "test-model";

const boardJob: JobValue = {
  arrangement: "Remote",
  company: "Acme",
  feed: "greenhouse:acme",
  firstSeenAt: 0,
  id: "greenhouse:acme:1",
  lastSeenAt: 0,
  location: "Remote - Canada",
  postedAt: 0,
  region: "RemoteCanada",
  relevance: 50,
  role: "Director",
  salary: null,
  source: "Greenhouse",
  title: "Director of Engineering",
  url: "https://jobs.example/1",
};

const aggregatorJob: JobValue = {
  ...boardJob,
  company: "Globex",
  feed: "remoteok:all",
  id: "remoteok:all:1",
  source: "RemoteOK",
};

const statedPosting =
  "You will lead a team of 24 engineers and report to the VP of Engineering. Base salary US$180,000 - US$220,000 per year, remote in Canada.";

const validAnswer: ModelAnswerValue = {
  remotePolicy: "RemoteInRegion",
  remotePolicyQuote: "remote in Canada",
  reportsTo: "  VP   of Engineering ",
  reportsToQuote: "report to the VP of Engineering",
  salaryMax: 220_000,
  salaryMin: 180_000,
  seniority: "Director",
  teamSize: 24,
  teamSizeQuote: "lead a team of 24 engineers",
};

const listAll: JobQueryValue = {
  limit: 100,
  maxAgeDays: 30,
  offset: 0,
  regions: [],
  roles: [],
  salaryFloor: null,
  search: "",
  seniorities: [],
  sort: "Newest",
};

type AnswerValue = Data.TaggedEnum<{
  Answers: { readonly answer: unknown };
  Unavailable: Record<never, never>;
}>;

const Answer = Data.taggedEnum<AnswerValue>();

interface Scenario {
  readonly answer: AnswerValue;
  readonly dailyModelCalls?: number;
  readonly enrichedBefore?: EnrichmentValue;
  readonly fetched?: Effect.Effect<string, PostingGone | PostingUnavailable>;
  readonly id?: string;
  readonly jobs?: readonly JobValue[];
  readonly text?: string;
}

const enrich = ({
  answer,
  dailyModelCalls,
  enrichedBefore,
  fetched,
  id = boardJob.id,
  jobs = [boardJob],
  text = statedPosting,
}: Scenario) =>
  Effect.gen(function* enrichScenario() {
    const memory = yield* makeMemoryJobStore;
    const requests: string[] = [];

    const texts = PostingTexts.of({
      fetch: () => fetched ?? Effect.succeed(text),
    });

    const enricher = ListingEnricher.of({
      extract: (request) => {
        requests.push(request.title);

        return Answer.$match(answer, {
          Answers: ({ answer: raw }) => Effect.succeed(raw),
          Unavailable: () =>
            Effect.fail(new EnricherUnavailable({ message: "model down" })),
        });
      },
      model: MODEL,
    });

    return yield* Effect.gen(function* runEnrichment() {
      const store = yield* JobStore;

      for (const [feed, listed] of Object.entries(
        Array.groupBy(jobs, (job) => job.feed)
      )) {
        yield* store.replaceFeed(feed, listed, 0);
      }

      if (enrichedBefore !== undefined) {
        yield* store.saveEnrichment(id, enrichedBefore);
      }

      const before = yield* store.find(id);
      const outcome = yield* enrichListing(id, dailyModelCalls);
      const after = yield* store.find(id);

      return {
        after,
        before,
        enrichments: memory.enrichments().size,
        outcome,
        requests,
        skipped: pipe(
          [...memory.skips().values()],
          Array.map((recorded) => recorded.reason)
        ),
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          memory.layer,
          Layer.succeed(PostingTexts, texts),
          Layer.succeed(ListingEnricher, enricher)
        )
      )
    );
  });

const reasonOf = (outcome: EnrichmentOutcomeValue) =>
  EnrichmentOutcome.$match(outcome, {
    Enriched: () => "Enriched",
    Skipped: (skipped) => skipped.reason,
  });

const answerFields = Object.keys(ModelAnswer.fields);

const malformedAnswers = Arbitrary.map(
  Arbitrary.all([
    Arbitrary.schema(ModelAnswer),
    Arbitrary.schema(
      Schema.Int.check(
        Schema.isBetween({ maximum: answerFields.length - 1, minimum: 0 })
      )
    ),
  ]),
  ([answer, field]) => ({
    ...answer,
    [answerFields[field] ?? "seniority"]: { nested: true },
  })
);

const bandedAnswers = Arbitrary.map(
  Arbitrary.all([
    Arbitrary.schema(ModelAnswer),
    Arbitrary.schema(AnnualAmount),
    Arbitrary.schema(AnnualAmount),
  ]),
  ([answer, low, high]): ModelAnswerValue => ({
    ...answer,
    salaryMax: Math.max(low, high),
    salaryMin: Math.min(low, high),
  })
);

const unrelatedAmounts = Arbitrary.array(
  Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ maximum: 9_000_000, minimum: 0 }))
  ),
  { maxLength: 6 }
);

describe("enrichListing", () => {
  it.effect.prop(
    "a model answer that does not decode leaves the listing exactly as it was and skips as Malformed",
    { answer: malformedAnswers },
    ({ answer }) =>
      Effect.gen(function* malformed() {
        const result = yield* enrich({ answer: Answer.Answers({ answer }) });

        expect(reasonOf(result.outcome)).toBe("Malformed");
        expect(result.after).toStrictEqual(
          Option.some({ ...boardJob, enrichment: null })
        );
        expect(result.after).toStrictEqual(result.before);
        expect(result.enrichments).toBe(0);
        expect(result.skipped).toStrictEqual(["Malformed"]);
      })
  );

  it.effect(
    "an unavailable model skips as ModelUnavailable, leaves the listing unenriched, and records the skip for the sweep to retry",
    () =>
      Effect.gen(function* modelDown() {
        const result = yield* enrich({ answer: Answer.Unavailable() });

        expect(reasonOf(result.outcome)).toBe("ModelUnavailable");
        expect(skipHandling.ModelUnavailable).toBe("Retry");
        expect(result.requests).toStrictEqual([boardJob.title]);
        expect(result.after).toStrictEqual(
          Option.some({ ...boardJob, enrichment: null })
        );
        expect(result.enrichments).toBe(0);
        expect(result.skipped).toStrictEqual(["ModelUnavailable"]);
      })
  );

  it.effect(
    "a valid answer is saved, returned as Enriched, and listed on the board",
    () =>
      Effect.gen(function* valid() {
        yield* TestClock.adjust("3 hours");

        const memory = yield* makeMemoryJobStore;

        const enriched = yield* Effect.gen(function* enrichThenList() {
          const store = yield* JobStore;

          yield* store.replaceFeed(boardJob.feed, [boardJob], 0);

          const outcome = yield* enrichListing(boardJob.id);
          const page = yield* listJobs.handler(listAll);
          const found = yield* store.find(boardJob.id);

          return { found, outcome, page };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              memory.layer,
              Layer.succeed(
                PostingTexts,
                PostingTexts.of({ fetch: () => Effect.succeed(statedPosting) })
              ),
              Layer.succeed(
                ListingEnricher,
                ListingEnricher.of({
                  extract: () => Effect.succeed(validAnswer),
                  model: MODEL,
                })
              )
            )
          )
        );

        const now = yield* Clock.currentTimeMillis;

        const expected: EnrichmentValue = {
          enrichedAt: now,
          model: MODEL,
          remotePolicy: "RemoteInRegion",
          reportsTo: "VP of Engineering",
          salary: { currency: "USD", max: 220_000, min: 180_000 },
          seniority: "Director",
          teamSize: 24,
        };

        expect(enriched.outcome).toStrictEqual(
          EnrichmentOutcome.Enriched({ enrichment: expected, id: boardJob.id })
        );
        expect(enriched.found).toStrictEqual(
          Option.some({ ...boardJob, enrichment: expected })
        );
        expect(
          pipe(
            enriched.page.jobs,
            Array.map((job) => [job.id, job.enrichment])
          )
        ).toStrictEqual([[boardJob.id, expected]]);
      })
  );

  it.effect.prop(
    "a salary band the posting text never states is saved as no salary, never invented",
    { amounts: unrelatedAmounts, answer: bandedAnswers },
    ({ amounts, answer }) =>
      Effect.gen(function* unstatedSalary() {
        const stated = new Set([answer.salaryMin, answer.salaryMax]);

        const text = `Compensation follows our bands: ${pipe(
          amounts,
          Array.filter((amount) => !stated.has(amount)),
          Array.map((amount) => `$${amount}`),
          Array.join("; ")
        )}`;

        const result = yield* enrich({
          answer: Answer.Answers({ answer }),
          text,
        });

        expect(reasonOf(result.outcome)).toBe("Enriched");
        expect(
          pipe(
            result.after,
            Option.map((job) => job.enrichment?.salary)
          )
        ).toStrictEqual(Option.some(null));
      })
  );

  it.effect(
    "the same band is kept when the posting states it, so the property above is not vacuous",
    () =>
      Effect.gen(function* statedSalary() {
        const result = yield* enrich({
          answer: Answer.Answers({ answer: validAnswer }),
          text: "Pay range 180k to 220k CAD",
        });

        expect(
          pipe(
            result.after,
            Option.map((job) => job.enrichment?.salary)
          )
        ).toStrictEqual(
          Option.some({ currency: "CAD", max: 220_000, min: 180_000 })
        );
      })
  );

  it.effect.each([
    [
      "half a band",
      "Base salary $150,000 per year, plus equity.",
      150_000,
      900_000,
      null,
    ],
    [
      "two amounts from different sentences",
      "Base salary $150,000. Equity grant worth $900,000 over four years.",
      150_000,
      900_000,
      null,
    ],
    [
      "a yearly band",
      "Base salary $150,000 - $200,000 per year.",
      150_000,
      200_000,
      { currency: "USD", max: 200_000, min: 150_000 },
    ],
    [
      "a band in pounds",
      "Base salary £80,000 - £90,000.",
      80_000,
      90_000,
      { currency: "GBP", max: 90_000, min: 80_000 },
    ],
    [
      "a dollar band with a CAD code",
      "Pay range $142,800—$184,800 CAD",
      142_800,
      184_800,
      { currency: "CAD", max: 184_800, min: 142_800 },
    ],
    [
      "an hourly band",
      "Pay is $75 - $95 per hour.",
      75,
      95,
      { currency: "USD", max: 197_600, min: 156_000 },
    ],
    [
      "a monthly band in euros",
      "Gross pay €8,000 - €10,000 per month.",
      8000,
      10_000,
      { currency: "EUR", max: 120_000, min: 96_000 },
    ],
    ["small amounts with no period", "Pay is $75 - $95.", 75, 95, null],
    [
      "a 401k match",
      "We match your 401k contributions.",
      401_000,
      401_000,
      null,
    ],
    [
      "an unsupported currency",
      "₹9,424,000—₹9,424,500 INR",
      9_424_000,
      9_424_500,
      null,
    ],
    [
      "a single amount",
      "Salary: $180,000 per year.",
      180_000,
      180_000,
      { currency: "USD", max: 180_000, min: 180_000 },
    ],
    [
      "a salary floor",
      "Salary starting from 5000 EUR/month.",
      5000,
      5000,
      null,
    ],
    [
      "a bare dollar band in Canada",
      "Location: Toronto, Canada\nSalary: $150,000 - $180,000 per year",
      150_000,
      180_000,
      null,
    ],
    [
      "a US dollar band in Canada",
      "Location: Toronto, Canada\nSalary: US$150,000 - US$180,000 per year",
      150_000,
      180_000,
      { currency: "USD", max: 180_000, min: 150_000 },
    ],
    [
      "a band in two currencies",
      "Base salary £80,000 - €95,000 per year.",
      80_000,
      95_000,
      null,
    ],
    [
      "a salary ceiling",
      "Pay: up to $200,000 per year",
      200_000,
      200_000,
      null,
    ],
    [
      "a band that starts from its low end",
      "Pay from €60,000 to €75,000 per year.",
      60_000,
      75_000,
      { currency: "EUR", max: 75_000, min: 60_000 },
    ],
  ] as const)(
    "a salary of %s is read from the posting's own currency and period",
    ([, text, low, high, saved]) =>
      Effect.gen(function* salaryFromPosting() {
        const result = yield* enrich({
          answer: Answer.Answers({
            answer: { ...validAnswer, salaryMax: high, salaryMin: low },
          }),
          text,
        });

        expect(
          pipe(
            result.after,
            Option.map((found) => found.enrichment?.salary)
          )
        ).toStrictEqual(Option.some(saved));
      })
  );

  it.effect.each([
    [
      "a reporting line the posting states",
      "VP of Engineering",
      "You will report to the VP of Engineering.",
      "report to the VP of Engineering",
      "VP of Engineering",
    ],
    [
      "a reports-to line",
      "Engineering Director",
      "Reports to: Engineering Director\nDirect Reports: 8-12",
      "Reports to: Engineering Director",
      "Engineering Director",
    ],
    [
      "a missing quote",
      null,
      "You will report to the VP of Engineering.",
      null,
      "VP of Engineering",
    ],
    [
      "a quote the posting never says",
      null,
      "You will lead the platform group.",
      "report to the CTO",
      "CTO",
    ],
    [
      "a quote naming someone else",
      null,
      "You will report to the CTO and partner with the VP of Engineering.",
      "report to the CTO",
      "VP of Engineering",
    ],
    [
      "a title outside the words the posting says",
      null,
      "The role reports to the CEO.",
      "VP of Sales and the role reports to the CEO",
      "VP of Sales",
    ],
    [
      "a reworded opening",
      "CEO",
      "The role reports to the CEO.",
      "VP of Sales and the role reports to the CEO",
      "CEO",
    ],
    [
      "a partnership",
      null,
      "You will partner closely with the VP of Engineering.",
      "partner closely with the VP of Engineering",
      "VP of Engineering",
    ],
  ] as const)(
    "a reports-to quoted from %s is saved as %s",
    ([, saved, text, quote, answered]) =>
      Effect.gen(function* reportsToFromPosting() {
        const result = yield* enrich({
          answer: Answer.Answers({
            answer: {
              ...validAnswer,
              reportsTo: answered,
              reportsToQuote: quote,
            },
          }),
          text,
        });

        expect(
          pipe(
            result.after,
            Option.map((found) => found.enrichment?.reportsTo)
          )
        ).toStrictEqual(Option.some(saved));
      })
  );

  it.effect.each([
    [
      "Global Financial Operations Platform Director",
      "SeniorDirector",
      "Director",
    ],
    ["Senior Director, Security Architecture", "Director", "SeniorDirector"],
    ["Manager, Starlink Engineering", "Director", "Manager"],
    ["Head of Platform Engineering", "VicePresident", "VicePresident"],
    ["Head of Engineering", "Director", "Director"],
    ["Head of Engineering", "Executive", "Director"],
    [
      "Head of Engineering - Financial Data Experience",
      "SeniorManager",
      "Director",
    ],
    ["Head of Engineering, Office of the CTO", null, "Director"],
    ["Staff Software Engineer", "VicePresident", null],
    ["Software Engineer", "Manager", null],
  ] as const)(
    "%s with a model answer of %s is saved as %s, so seniority agrees with the title",
    ([title, answered, saved]) =>
      Effect.gen(function* seniorityFromTitle() {
        const job: JobValue = { ...boardJob, title };

        const result = yield* enrich({
          answer: Answer.Answers({
            answer: { ...validAnswer, seniority: answered },
          }),
          jobs: [job],
        });

        expect(
          pipe(
            result.after,
            Option.map((found) => found.enrichment?.seniority)
          )
        ).toStrictEqual(Option.some(saved));
      })
  );

  it.effect.each([
    [
      "a past-experience requirement",
      null,
      "2+ years of experience leading a team of 10+ individuals as direct reports",
      "leading a team of 10+ individuals as direct reports",
      10,
    ],
    [
      "a quote the posting never says",
      null,
      "You will lead the platform group.",
      "lead a team of 12",
      12,
    ],
    [
      "a missing quote",
      null,
      "You will lead a team of 12 engineers.",
      null,
      12,
    ],
    [
      "a count of teams",
      null,
      "You'll lead the quality engineers and SDETs behind it — 10 scrum teams, with engineers in Canada, the US, and India.",
      "10 scrum teams",
      10,
    ],
    [
      "a team the role joins",
      null,
      "You will join a team of 40 engineers.",
      "join a team of 40 engineers",
      40,
    ],
    [
      "a team the role joins and leads",
      40,
      "You will join us and lead a team of 40 engineers.",
      "lead a team of 40 engineers",
      40,
    ],
    [
      "a number of people",
      20,
      "You will lead a team of approximately 20 people organized across four functional areas.",
      "a team of approximately 20 people",
      20,
    ],
    [
      "the team being hired into",
      8,
      "Reports to: Engineering Director\nDirect Reports: 8-12\nLead and develop a SharedCX engineering team.",
      "Direct Reports: 8-12",
      8,
    ],
  ] as const)(
    "a team size quoted from %s is saved as %s",
    ([, saved, text, quote, answered]) =>
      Effect.gen(function* teamSizeFromPosting() {
        const result = yield* enrich({
          answer: Answer.Answers({
            answer: {
              ...validAnswer,
              teamSize: answered,
              teamSizeQuote: quote,
            },
          }),
          text: `${text} Base salary $180,000 - $220,000 per year.`,
        });

        expect(
          pipe(
            result.after,
            Option.map((found) => found.enrichment?.teamSize)
          )
        ).toStrictEqual(Option.some(saved));
      })
  );

  it.effect.each([
    [
      "a country",
      null,
      "Onsite",
      "You will be based in the UAE and should be willing to relocate there.",
    ],
    ["travel", null, "Hybrid", "Ability to travel up to 25-50% as required."],
    [
      "experience with remote teams",
      null,
      "Remote",
      "Experience leading and scaling distributed or remote teams.",
    ],
    [
      "office days",
      "Onsite",
      "Onsite",
      "This role is based in our Menlo Park, CA office, with in-person attendance expected 5 days per week.",
    ],
    ["a negated policy", null, "Remote", "This is not a remote role."],
    ["a hybrid tag", "Hybrid", "Hybrid", "#LI-Hybrid"],
    ["an onsite tag the model left out", "Onsite", null, "#LI-ONSITE"],
    ["a remote tag the model left out", "Remote", null, "#LI-Remote"],
    ["a hybrid tag the model left out", "Hybrid", null, "#LI-Hybrid"],
    [
      "a stated policy over a conflicting tag",
      "Hybrid",
      "Hybrid",
      "Hybrid, three days a week in the office. #LI-Onsite",
    ],
    [
      "a quote that spans two sentences",
      "Hybrid",
      "Hybrid",
      "Location-based hybrid policy. We expect all staff in one of our offices at least 25% of the time.",
    ],
    [
      "monthly office visits",
      null,
      "Hybrid",
      "You will be expected to work in the office 1-2 times/month and therefore can be situated anywhere in the country.",
    ],
    [
      "monthly office visits read as onsite",
      null,
      "Onsite",
      "You will be expected to work in the office 1-2 times/month and therefore can be situated anywhere in the country.",
    ],
    ["a board's workplace type", "Hybrid", "Hybrid", "Workplace type: Hybrid"],
    [
      "an office share the model left out",
      "Hybrid",
      null,
      "Location-based hybrid policy: Currently, we expect all staff to be in one of our offices at least 25% of the time.",
    ],
    [
      "a negated office share the model left out",
      null,
      null,
      "This role is fully remote and is not subject to our hybrid policy.",
    ],
  ] as const)(
    "a remote policy quoted from %s is saved as %s",
    ([, saved, answered, quote]) =>
      Effect.gen(function* remotePolicyFromPosting() {
        const result = yield* enrich({
          answer: Answer.Answers({
            answer: {
              ...validAnswer,
              remotePolicy: answered,
              remotePolicyQuote: quote,
            },
          }),
          text: `${quote}\nBase salary $180,000 - $220,000 per year.`,
        });

        expect(
          pipe(
            result.after,
            Option.map((found) => found.enrichment?.remotePolicy)
          )
        ).toStrictEqual(Option.some(saved));
      })
  );

  it.effect.each([
    [
      "a travel requirement",
      null,
      "This role requires travel 25% of the time.",
      "travel 25% of the time",
    ],
    [
      "a weekday meeting",
      null,
      "Team planning happens on Mondays over video.",
      "Team planning happens on Mondays",
    ],
    [
      "office weekdays",
      "Hybrid",
      "You will work from our London office on Tuesdays and Thursdays.",
      "work from our London office on Tuesdays and Thursdays",
    ],
    [
      "a share of time in the office",
      "Hybrid",
      "We expect you in the office 40% of the time.",
      "We expect you in the office 40% of the time",
    ],
    [
      "only its last two words in the posting",
      null,
      "We build hybrid cloud tooling.",
      "This role is hybrid cloud",
    ],
  ] as const)(
    "a hybrid answer quoted from %s is saved as %s",
    ([, saved, text, quote]) =>
      Effect.gen(function* hybridFromPosting() {
        const result = yield* enrich({
          answer: Answer.Answers({
            answer: {
              ...validAnswer,
              remotePolicy: "Hybrid",
              remotePolicyQuote: quote,
            },
          }),
          text,
        });

        expect(
          pipe(
            result.after,
            Option.map((found) => found.enrichment?.remotePolicy)
          )
        ).toStrictEqual(Option.some(saved));
      })
  );

  it.effect.each([
    [
      "a reworded opening",
      "Hybrid",
      "We offer hybrid NY-based positions (four days/week in-office).",
    ],
    [
      "its only cue in the reworded opening",
      null,
      "Hybrid policy: NY-based positions (four days/week in-office).",
    ],
  ] as const)(
    "a remote-policy quote with %s is saved as %s",
    ([, saved, quote]) =>
      Effect.gen(function* rewordedQuote() {
        const result = yield* enrich({
          answer: Answer.Answers({
            answer: {
              ...validAnswer,
              remotePolicy: "Hybrid",
              remotePolicyQuote: quote,
            },
          }),
          text: "We're headquartered in NYC and offer hybrid NY-based positions (four days/week in-office).\nBase salary $180,000 - $220,000 per year.",
        });

        expect(
          pipe(
            result.after,
            Option.map((found) => found.enrichment?.remotePolicy)
          )
        ).toStrictEqual(Option.some(saved));
      })
  );

  it.effect.each(["", "  \n\t "])(
    "a posting with no text (%j) skips as EmptyPosting, asks no model, and is not retried",
    (text) =>
      Effect.gen(function* emptyPosting() {
        const result = yield* enrich({
          answer: Answer.Answers({ answer: validAnswer }),
          text,
        });

        expect(reasonOf(result.outcome)).toBe("EmptyPosting");
        expect(result.requests).toStrictEqual([]);
        expect(result.enrichments).toBe(0);
        expect(result.skipped).toStrictEqual(["EmptyPosting"]);
      })
  );

  it.effect(
    "a posting its board no longer serves skips as Gone, asks no model, and is recorded so no sweep retries it",
    () =>
      Effect.gen(function* postingGone() {
        const result = yield* enrich({
          answer: Answer.Answers({ answer: validAnswer }),
          fetched: Effect.fail(
            new PostingGone({ id: boardJob.id, message: "404" })
          ),
        });

        expect(reasonOf(result.outcome)).toBe("Gone");
        expect(result.requests).toStrictEqual([]);
        expect(result.enrichments).toBe(0);
        expect(result.skipped).toStrictEqual(["Gone"]);
      })
  );

  it.effect(
    "a posting that fails to load skips as PostingUnavailable, asks no model, and records the skip for the sweep to retry",
    () =>
      Effect.gen(function* postingUnavailable() {
        const result = yield* enrich({
          answer: Answer.Answers({ answer: validAnswer }),
          fetched: Effect.fail(
            new PostingUnavailable({ id: boardJob.id, message: "503" })
          ),
        });

        expect(reasonOf(result.outcome)).toBe("PostingUnavailable");
        expect(skipHandling.PostingUnavailable).toBe("Retry");
        expect(result.requests).toStrictEqual([]);
        expect(result.skipped).toStrictEqual(["PostingUnavailable"]);
      })
  );

  it.effect(
    "an id no longer on the board skips as Gone and asks no model",
    () =>
      Effect.gen(function* gone() {
        const result = yield* enrich({
          answer: Answer.Answers({ answer: validAnswer }),
          id: "greenhouse:acme:404",
        });

        expect(reasonOf(result.outcome)).toBe("Gone");
        expect(result.requests).toStrictEqual([]);
        expect(result.enrichments).toBe(0);
      })
  );

  it.effect(
    "an aggregator listing skips as Unsupported and asks no model",
    () =>
      Effect.gen(function* unsupported() {
        const result = yield* enrich({
          answer: Answer.Answers({ answer: validAnswer }),
          id: aggregatorJob.id,
          jobs: [boardJob, aggregatorJob],
        });

        expect(reasonOf(result.outcome)).toBe("Unsupported");
        expect(result.requests).toStrictEqual([]);
        expect(result.after).toStrictEqual(
          Option.some({ ...aggregatorJob, enrichment: null })
        );
      })
  );

  it.effect(
    "an enriched listing skips as AlreadyEnriched and keeps its first enrichment",
    () =>
      Effect.gen(function* alreadyEnriched() {
        const earlier: EnrichmentValue = {
          enrichedAt: 0,
          model: "earlier-model",
          remotePolicy: null,
          reportsTo: null,
          salary: null,
          seniority: "Manager",
          teamSize: null,
        };

        const result = yield* enrich({
          answer: Answer.Answers({ answer: validAnswer }),
          enrichedBefore: earlier,
        });

        expect(reasonOf(result.outcome)).toBe("AlreadyEnriched");
        expect(result.requests).toStrictEqual([]);
        expect(result.after).toStrictEqual(
          Option.some({ ...boardJob, enrichment: earlier })
        );
      })
  );

  it.effect.each([
    [
      "a weekday that is not an office day",
      "Hybrid",
      "Applications are reviewed on Mondays.",
      "Applications are reviewed on Mondays",
    ],
    [
      "an in-person interview",
      "Onsite",
      "The final round is an in-person interview.",
      "an in-person interview",
    ],
    [
      "remote teams the role works with",
      "Remote",
      "We partner with remote teams across the globe.",
      "partner with remote teams",
    ],
    [
      "remote work negated after the word",
      "Remote",
      "Remote work is not available for this role.",
      "Remote work is not available",
    ],
  ] as const)("a %s does not make the posting %s", ([, claimed, text, quote]) =>
    Effect.gen(function* decoyPolicy() {
      const result = yield* enrich({
        answer: Answer.Answers({
          answer: {
            ...validAnswer,
            remotePolicy: claimed,
            remotePolicyQuote: quote,
          },
        }),
        text,
      });

      expect(
        pipe(
          result.after,
          Option.map((found) => found.enrichment?.remotePolicy)
        )
      ).toStrictEqual(Option.some(null));
    })
  );

  it.effect.each([
    [
      "a remote answer against an onsite Lever workplace type",
      "Onsite",
      "Remote",
      "This role is fully remote.\n\nWorkplace type: onsite",
    ],
    [
      "a hybrid answer against an onsite Ashby workplace type",
      "Onsite",
      "Hybrid",
      "This role is hybrid, three days a week in the office.\n\nWorkplace type: OnSite",
    ],
    [
      "a remote-in-region answer under a remote workplace type",
      "RemoteInRegion",
      "RemoteInRegion",
      "This role is remote in Canada.\n\nWorkplace type: remote",
    ],
    [
      "no answer under a hybrid workplace type",
      "Hybrid",
      null,
      "We build developer tools.\n\nWorkplace type: hybrid",
    ],
  ] as const)(
    "the ATS workplace type wins over %s, saved as %s",
    ([, saved, claimed, text]) =>
      Effect.gen(function* structuredPolicy() {
        const result = yield* enrich({
          answer: Answer.Answers({
            answer: {
              ...validAnswer,
              remotePolicy: claimed,
              remotePolicyQuote: text.split("\n")[0] ?? null,
            },
          }),
          text,
        });

        expect(
          pipe(
            result.after,
            Option.map((found) => found.enrichment?.remotePolicy)
          )
        ).toStrictEqual(Option.some(saved));
      })
  );

  it.effect.each([
    ["someone else's reporting line", null, "Our CTO reports to the CEO."],
    ["the role's own reporting line", "CEO", "This role reports to the CEO."],
  ] as const)("a reports-to quoted from %s is saved as %s", ([, saved, text]) =>
    Effect.gen(function* reportingSubject() {
      const result = yield* enrich({
        answer: Answer.Answers({
          answer: {
            ...validAnswer,
            reportsTo: "CEO",
            reportsToQuote: text.slice(0, -1),
          },
        }),
        text,
      });

      expect(
        pipe(
          result.after,
          Option.map((found) => found.enrichment?.reportsTo)
        )
      ).toStrictEqual(Option.some(saved));
    })
  );

  it.effect.each([
    ["engineers the company has", null, "Our 12 engineers ship weekly."],
    ["engineers the role manages", 12, "You will manage 12 engineers."],
  ] as const)("a team size quoted from %s is saved as %s", ([, saved, text]) =>
    Effect.gen(function* teamSubject() {
      const result = yield* enrich({
        answer: Answer.Answers({
          answer: {
            ...validAnswer,
            teamSize: 12,
            teamSizeQuote: text.slice(0, -1),
          },
        }),
        text,
      });

      expect(
        pipe(
          result.after,
          Option.map((found) => found.enrichment?.teamSize)
        )
      ).toStrictEqual(Option.some(saved));
    })
  );

  it.effect.each([
    [
      "a stipend range",
      "Base salary $150,000 - $180,000 per year.\n$20,000 - $50,000 learning stipend",
      20_000,
      50_000,
      null,
    ],
    [
      "a stipend range on a line that names salary",
      "Salary and perks: $20,000 - $50,000 learning stipend",
      20_000,
      50_000,
      null,
    ],
    [
      "a range on a line that never names pay",
      "Referral reward $20,000 - $50,000 per year.",
      20_000,
      50_000,
      null,
    ],
    [
      "a range labelled as a stipend",
      "Learning stipend: $20,000 - $50,000",
      20_000,
      50_000,
      null,
    ],
    [
      "a bonus range after the base",
      "Base salary $150,000 - $180,000 per year. Annual bonus $20,000 - $50,000.",
      20_000,
      50_000,
      null,
    ],
    [
      "one end of a wider band",
      "Base salary $100,000 - $200,000 per year.",
      200_000,
      200_000,
      null,
    ],
    [
      "a base band followed by a bonus",
      "Base salary $180,000 - $220,000 per year plus bonus and equity.",
      180_000,
      220_000,
      { currency: "USD", max: 220_000, min: 180_000 },
    ],
    [
      "a bare range under a salary heading",
      "Annual Base Salary\n$142,800—$184,800 CAD",
      142_800,
      184_800,
      { currency: "CAD", max: 184_800, min: 142_800 },
    ],
    [
      "a bare range under a bonus heading",
      "Annual Bonus\n$20,000—$50,000 USD",
      20_000,
      50_000,
      null,
    ],
  ] as const)(
    "pay from %s is saved as %j, so only base pay counts as salary",
    ([, text, low, high, saved]) =>
      Effect.gen(function* basePayOnly() {
        const result = yield* enrich({
          answer: Answer.Answers({
            answer: { ...validAnswer, salaryMax: high, salaryMin: low },
          }),
          text,
        });

        expect(
          pipe(
            result.after,
            Option.map((found) => found.enrichment?.salary)
          )
        ).toStrictEqual(Option.some(saved));
      })
  );

  it("a 12,000-character posting with no sentence breaks and long fabricated quotes is checked in milliseconds and saves nothing it does not state", () => {
    const text = "remote hybrid office mondays report to lead 12 engineers $1 "
      .repeat(200)
      .slice(0, 12_000);

    const fabricated = Array.makeBy(
      100,
      (index) => `remote office hybrid report lead ${index}`
    ).join(" ");

    const started = performance.now();

    const details = detailsOfAnswer(
      {
        ...validAnswer,
        remotePolicy: "Hybrid",
        remotePolicyQuote: fabricated,
        reportsTo: "CEO",
        reportsToQuote: fabricated,
        teamSize: 12,
        teamSizeQuote: fabricated,
      },
      { company: "Acme", text, title: "Engineering Manager" }
    );

    expect(performance.now() - started).toBeLessThan(50);
    expect(details).toStrictEqual({
      remotePolicy: null,
      reportsTo: null,
      salary: null,
      seniority: "Manager",
      teamSize: null,
    });
  });

  it.effect(
    "a quote over 40 words is judged on its last 40, so a cue only in its opening is not enough",
    () =>
      Effect.gen(function* longQuote() {
        const sentence = `Hybrid ${Array.makeBy(41, () => "teams").join(" ")}`;

        const result = yield* enrich({
          answer: Answer.Answers({
            answer: {
              ...validAnswer,
              remotePolicy: "Hybrid",
              remotePolicyQuote: sentence,
            },
          }),
          text: `${sentence}.`,
        });

        expect(
          pipe(
            result.after,
            Option.map((found) => found.enrichment?.remotePolicy)
          )
        ).toStrictEqual(Option.some(null));
      })
  );

  it.effect(
    "a defect in the guards records a final Malformed skip instead of failing the queue handler",
    () =>
      Effect.gen(function* guardDefect() {
        const normalize = vi
          .spyOn(String.prototype, "normalize")
          .mockImplementation(() => {
            throw new Error("guard defect");
          });

        const result = yield* enrich({
          answer: Answer.Answers({ answer: validAnswer }),
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              normalize.mockRestore();
            })
          )
        );

        expect(reasonOf(result.outcome)).toBe("Malformed");
        expect(skipHandling.Malformed).toBe("Final");
        expect(result.enrichments).toBe(0);
        expect(result.skipped).toStrictEqual(["Malformed"]);
      })
  );

  it.effect(
    "a spent daily cap skips as DailyCapReached, asks no model, and records the skip for a later sweep",
    () =>
      Effect.gen(function* capSpent() {
        const result = yield* enrich({
          answer: Answer.Answers({ answer: validAnswer }),
          dailyModelCalls: 0,
        });

        expect(reasonOf(result.outcome)).toBe("DailyCapReached");
        expect(skipHandling.DailyCapReached).toBe("Retry");
        expect(result.requests).toStrictEqual([]);
        expect(result.enrichments).toBe(0);
        expect(result.skipped).toStrictEqual(["DailyCapReached"]);
      })
  );

  it.effect(
    "the daily cap counts every model call, so the call after the cap asks no model",
    () =>
      Effect.gen(function* capCounts() {
        const memory = yield* makeMemoryJobStore;
        const requests: string[] = [];
        const second: JobValue = { ...boardJob, id: "greenhouse:acme:2" };

        const outcomes = yield* Effect.gen(function* enrichTwo() {
          const store = yield* JobStore;

          yield* store.replaceFeed(boardJob.feed, [boardJob, second], 0);

          return [
            yield* enrichListing(boardJob.id, 1),
            yield* enrichListing(second.id, 1),
          ];
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              memory.layer,
              Layer.succeed(
                PostingTexts,
                PostingTexts.of({ fetch: () => Effect.succeed(statedPosting) })
              ),
              Layer.succeed(
                ListingEnricher,
                ListingEnricher.of({
                  extract: (request) => {
                    requests.push(request.title);

                    return Effect.succeed(validAnswer);
                  },
                  model: MODEL,
                })
              )
            )
          )
        );

        expect(outcomes.map((outcome) => reasonOf(outcome))).toStrictEqual([
          "Enriched",
          "DailyCapReached",
        ]);
        expect(requests).toHaveLength(1);
      })
  );
});

describe("sweepLimitOf", () => {
  it.each([
    ["prod", Option.none(), DEFAULT_ENRICHMENT_SWEEP_LIMIT],
    ["verify-j6r10-cloud", Option.none(), 0],
    ["verify-j6r10-cloud", Option.some(8), 8],
    ["prod", Option.some(2), 2],
  ] as const)(
    "a %s stage configured with %s sweeps %s listings a run",
    (stage, configured, limit) => {
      expect(sweepLimitOf({ configured, stage })).toBe(limit);
    }
  );
});

const boardFeed: FeedRef = {
  company: Option.some("Acme"),
  key: "greenhouse:acme",
  minIntervalMinutes: 1,
  source: "Greenhouse",
};

const aggregatorFeed: FeedRef = {
  company: Option.some("Globex"),
  key: "remoteok:all",
  minIntervalMinutes: 1,
  source: "RemoteOK",
};

const ExternalId = Schema.Literals(["a", "b", "c", "d", "e"]);

const ListingRun = Schema.Struct({
  aggregator: Schema.Array(ExternalId),
  board: Schema.Array(ExternalId),
});

type ListingRunValue = typeof ListingRun.Type;

const listingRuns = Arbitrary.array(Arbitrary.schema(ListingRun), {
  maxLength: 10,
  minLength: 1,
});

const sweepLimits = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 1 }))
);

const postingFor =
  (company: string) =>
  (id: string): PostingValue => ({
    company,
    externalId: id,
    location: "Remote - Canada",
    postedAt: null,
    salary: null,
    title: `Director of Engineering, Team ${id}`,
    url: `https://jobs.example/${company}/${id}`,
    workplace: "Unspecified",
  });

const RUN_GAP_HOURS = 2;

const WINDOW_HOURS = 3;

interface SweepOptions {
  readonly afterRun?: (
    run: number
  ) => Effect.Effect<void, JobStoreUnavailable, JobStore>;
  readonly limit?: number;
  readonly queueDownOnRun?: number;
}

const ingestAndSweep = (
  runs: readonly ListingRunValue[],
  {
    afterRun = () => Effect.void,
    limit = 100,
    queueDownOnRun,
  }: SweepOptions = {}
) =>
  Effect.gen(function* replayRuns() {
    const memory = yield* makeMemoryJobStore;
    const queued: (readonly string[])[] = [];

    for (const [index, run] of runs.entries()) {
      const queue = EnrichmentQueue.of({
        enqueue: (ids) =>
          index === queueDownOnRun
            ? Effect.fail(new EnrichmentQueueUnavailable({ message: "down" }))
            : Effect.sync(() => {
                queued.push(ids);
              }),
      });

      const feeds = PostingFeeds.of({
        catalog: [boardFeed, aggregatorFeed],
        fetch: (feed) =>
          Effect.succeed(
            feed.key === boardFeed.key
              ? pipe(run.board, Array.map(postingFor("Acme")))
              : pipe(run.aggregator, Array.map(postingFor("Globex")))
          ),
      });

      yield* Effect.gen(function* ingestThenSweep() {
        const { receipt } = yield* runIngest({
          feedConcurrency: 2,
          feedsPerRun: 2,
        });

        yield* enqueueUnenriched({
          limit,
          now: receipt.startedAt,
          windowHours: WINDOW_HOURS,
        }).pipe(
          Effect.catchTag("EnrichmentQueueUnavailable", () => Effect.void)
        );

        yield* afterRun(index);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            memory.layer,
            Layer.succeed(PostingFeeds, feeds),
            Layer.succeed(EnrichmentQueue, queue)
          )
        )
      );

      yield* TestClock.adjust(`${RUN_GAP_HOURS} hours`);
    }

    return queued;
  });

const boardId = (id: string) => `${boardFeed.key}:${id}`;

const run = (board: readonly string[], aggregator: readonly string[] = []) =>
  Schema.decodeUnknownSync(ListingRun)({ aggregator, board });

describe("enqueueUnenriched", () => {
  it.effect.prop(
    "each run queues the newest company-board listings first seen within the window, up to the cap",
    { limit: sweepLimits, runs: listingRuns },
    ({ limit, runs }) =>
      Effect.gen(function* sweptListings() {
        const queued = yield* ingestAndSweep(runs, { limit });

        const firstSeen = new Map<string, number>();

        const expected = pipe(
          runs,
          Array.map((current, index) => {
            const previous = new Set(runs[index - 1]?.board);

            for (const id of Array.dedupe(current.board)) {
              if (!previous.has(id)) {
                firstSeen.set(id, index);
              }
            }

            return pipe(
              Array.dedupe(current.board),
              Array.filter(
                (id) =>
                  (index - (firstSeen.get(id) ?? index)) * RUN_GAP_HOURS <=
                  WINDOW_HOURS
              ),
              (ids) =>
                ids.toSorted(
                  (left, right) =>
                    (firstSeen.get(right) ?? 0) - (firstSeen.get(left) ?? 0) ||
                    left.localeCompare(right)
                ),
              Array.take(limit),
              Array.map(boardId)
            );
          })
        );

        expect(queued).toStrictEqual(expected);
      })
  );

  it.effect("a listing whose enqueue failed is queued by the next run", () =>
    Effect.gen(function* missedEnqueue() {
      const queued = yield* ingestAndSweep([run(["a"]), run(["a"])], {
        queueDownOnRun: 0,
      });

      expect(queued).toStrictEqual([[boardId("a")]]);
    })
  );

  it.effect(
    "enriched and finally skipped listings are never queued again, retried ones are, and aggregator listings never are",
    () =>
      Effect.gen(function* settledListings() {
        const queued = yield* ingestAndSweep(
          [
            run(["a", "b", "c", "d", "e"], ["a", "d"]),
            run(["a", "b", "c", "d", "e"], ["a", "d"]),
          ],
          {
            afterRun: (index) =>
              index === 0
                ? Effect.gen(function* settle() {
                    const store = yield* JobStore;

                    yield* store.saveEnrichment(boardId("a"), {
                      enrichedAt: 0,
                      model: MODEL,
                      remotePolicy: null,
                      reportsTo: null,
                      salary: null,
                      seniority: null,
                      teamSize: null,
                    });
                    yield* store.recordSkip(boardId("b"), {
                      reason: "Malformed",
                      skippedAt: 0,
                    });
                    yield* store.recordSkip(boardId("c"), {
                      reason: "ModelUnavailable",
                      skippedAt: 0,
                    });
                    yield* store.recordSkip(boardId("d"), {
                      reason: "Gone",
                      skippedAt: 0,
                    });
                    yield* store.recordSkip(boardId("e"), {
                      reason: "EmptyPosting",
                      skippedAt: 0,
                    });
                  })
                : Effect.void,
          }
        );

        expect(queued).toStrictEqual([
          [
            boardId("a"),
            boardId("b"),
            boardId("c"),
            boardId("d"),
            boardId("e"),
          ],
          [boardId("c")],
        ]);
      })
  );
});

describe("enrichableSources", () => {
  it("is every company board and no aggregator", () => {
    expect(enrichableSources.toSorted()).toStrictEqual([
      "Ashby",
      "Greenhouse",
      "Lever",
      "SmartRecruiters",
      "Workable",
    ]);
  });
});

describe("moneyRangesIn", () => {
  it("reads each marked range with its currency and period, and skips numbers that are not money", () => {
    expect(
      moneyRangesIn(
        "CA$196.8K to CA$270.6K, or $142,800 to $184,800 USD per year.\nCAD $196,800 - $270,600\n401k match, 2025 start, team of 12, 5+ years.\nHourly: $40-$55"
      )
    ).toStrictEqual([
      { amounts: [196_800, 270_600], currency: "CAD", period: "Year" },
      { amounts: [142_800, 184_800], currency: "USD", period: "Year" },
      { amounts: [196_800, 270_600], currency: "CAD", period: "Year" },
      { amounts: [40, 55], currency: "USD", period: "Hour" },
    ]);
  });

  it("reads a k only as thousands when no letter follows it", () => {
    expect(moneyRangesIn("A $150 Kubernetes budget.")).toStrictEqual([
      { amounts: [150], currency: "USD", period: "Year" },
    ]);
  });
});
