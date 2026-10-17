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

import {
  amountsIn,
  AnnualAmount,
  Currency,
  EnricherUnavailable,
  EnrichmentOutcome,
  EnrichmentQueue,
  enqueueNewListings,
  enrichableSources,
  enrichListing,
  JobStore,
  ListingEnricher,
  listJobs,
  ModelAnswer,
  PostingFeeds,
  PostingTexts,
  runIngest,
} from "../src/index.js";
import type {
  EnrichmentOutcomeValue,
  EnrichmentValue,
  FeedRef,
  JobQueryValue,
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
  "Lead three teams. Base salary $180,000 - $220,000 per year, remote in Canada.";

const validAnswer: ModelAnswerValue = {
  remotePolicy: "RemoteInRegion",
  reportsTo: "  VP   of Engineering ",
  salaryCurrency: "usd",
  salaryMax: 220_000,
  salaryMin: 180_000,
  salaryPeriod: "Year",
  seniority: "Director",
  teamSize: 24,
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
  readonly enrichedBefore?: EnrichmentValue;
  readonly id?: string;
  readonly jobs?: readonly JobValue[];
  readonly text?: string;
}

const enrich = ({
  answer,
  enrichedBefore,
  id = boardJob.id,
  jobs = [boardJob],
  text = statedPosting,
}: Scenario) =>
  Effect.gen(function* enrichScenario() {
    const memory = yield* makeMemoryJobStore;
    const requests: string[] = [];

    const texts = PostingTexts.of({
      fetch: () => Effect.succeed(text),
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
      const outcome = yield* enrichListing(id);
      const after = yield* store.find(id);

      return {
        after,
        before,
        enrichments: memory.enrichments().size,
        outcome,
        requests,
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
    Arbitrary.schema(Currency),
    Arbitrary.schema(AnnualAmount),
    Arbitrary.schema(AnnualAmount),
  ]),
  ([answer, currency, low, high]): ModelAnswerValue => ({
    ...answer,
    salaryCurrency: currency,
    salaryMax: Math.max(low, high),
    salaryMin: Math.min(low, high),
    salaryPeriod: "Year",
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
      })
  );

  it.effect(
    "an unavailable model skips as ModelUnavailable and writes nothing",
    () =>
      Effect.gen(function* modelDown() {
        const result = yield* enrich({ answer: Answer.Unavailable() });

        expect(reasonOf(result.outcome)).toBe("ModelUnavailable");
        expect(result.requests).toStrictEqual([boardJob.title]);
        expect(result.after).toStrictEqual(
          Option.some({ ...boardJob, enrichment: null })
        );
        expect(result.enrichments).toBe(0);
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
          Array.map(String),
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
          answer: Answer.Answers({
            answer: { ...validAnswer, salaryCurrency: "CAD" },
          }),
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

const ExternalId = Schema.Literals(["a", "b", "c", "d"]);

const ListingRun = Schema.Struct({
  aggregator: Schema.Array(ExternalId),
  board: Schema.Array(ExternalId),
});

type ListingRunValue = typeof ListingRun.Type;

const listingRuns = Arbitrary.array(Arbitrary.schema(ListingRun), {
  maxLength: 10,
  minLength: 1,
});

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

const ingestAndEnqueue = (runs: readonly ListingRunValue[]) =>
  Effect.gen(function* replayRuns() {
    const memory = yield* makeMemoryJobStore;
    const queued: (readonly string[])[] = [];

    const queue = EnrichmentQueue.of({
      enqueue: (ids) =>
        Effect.sync(() => {
          queued.push(ids);
        }),
    });

    for (const run of runs) {
      const feeds = PostingFeeds.of({
        catalog: [boardFeed, aggregatorFeed],
        fetch: (feed) =>
          Effect.succeed(
            feed.key === boardFeed.key
              ? pipe(run.board, Array.map(postingFor("Acme")))
              : pipe(run.aggregator, Array.map(postingFor("Globex")))
          ),
      });

      yield* Effect.gen(function* ingestThenEnqueue() {
        const { receipt } = yield* runIngest({
          feedConcurrency: 2,
          feedsPerRun: 2,
        });

        yield* enqueueNewListings(receipt.startedAt);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            memory.layer,
            Layer.succeed(PostingFeeds, feeds),
            Layer.succeed(EnrichmentQueue, queue)
          )
        )
      );

      yield* TestClock.adjust("2 hours");
    }

    return queued;
  });

const boardId = (id: string) => `${boardFeed.key}:${id}`;

describe("enqueueNewListings", () => {
  it.effect.prop(
    "each run queues exactly the company-board ids that run listed for the first time",
    { runs: listingRuns },
    ({ runs }) =>
      Effect.gen(function* firstSightings() {
        const queued = yield* ingestAndEnqueue(runs);

        const expected = pipe(
          runs,
          Array.map((run, index) => {
            const previous = new Set(runs[index - 1]?.board);

            return pipe(
              Array.dedupe(run.board),
              Array.filter((id) => !previous.has(id)),
              Array.map(boardId),
              (ids) => ids.toSorted()
            );
          })
        );

        expect(queued).toStrictEqual(expected);
      })
  );

  it.effect(
    "a second run listing the same roles queues nothing, and aggregator roles are never queued",
    () =>
      Effect.gen(function* repeatRun() {
        const run: ListingRunValue = {
          aggregator: ["a", "c"],
          board: ["b", "a"],
        };

        const queued = yield* ingestAndEnqueue([run, run]);

        expect(queued).toStrictEqual([[boardId("a"), boardId("b")], []]);
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

describe("amountsIn", () => {
  it("reads decimal thousands shorthand as the exact whole amount", () => {
    const quoted = amountsIn("CA$196.8K to CA$270.6K, or $142,800 to $184,800");

    expect([...quoted].toSorted((left, right) => left - right)).toStrictEqual([
      142_800, 184_800, 196_800, 270_600,
    ]);
  });
});
