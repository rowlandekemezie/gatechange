import { describe, expect, it } from "@effect/vitest";
import type { PostingValue } from "@rat-stack/core";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  ashbyPostings,
  greenhousePostings,
  leverPostings,
  smartRecruitersPostings,
  workablePostings,
} from "../src/index.js";
import ashbyBoard from "./fixtures/ashby-board.json" with { type: "json" };
import greenhouseJob from "./fixtures/greenhouse-job.json" with { type: "json" };
import leverPosting from "./fixtures/lever-posting.json" with { type: "json" };
import smartRecruitersServiceNow from "./fixtures/smartrecruiters-servicenow.json" with { type: "json" };
import workableHuggingface from "./fixtures/workable-huggingface.json" with { type: "json" };

type RecordedBody =
  | typeof ashbyBoard
  | typeof smartRecruitersServiceNow
  | typeof workableHuggingface
  | readonly (typeof leverPosting)[]
  | { readonly jobs: readonly (typeof greenhouseJob)[] };

const replay = (recorded: RecordedBody) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(recorded))
      )
    )
  );

const recorded = <E>(
  board: string,
  read: Effect.Effect<readonly PostingValue[], E, HttpClient.HttpClient>,
  body: RecordedBody
) =>
  read.pipe(
    Effect.map((postings) => ({
      board,
      postings: postings.length,
      remote: postings.filter((posting) => posting.workplace !== "Unspecified")
        .length,
      salary: postings.filter((posting) => posting.salaryBand !== undefined)
        .length,
    })),
    Effect.provide(replay(body))
  );

describe("structured facts in recorded boards", () => {
  it.effect(
    "Lever and Ashby carry their structured salary band and every board with a workplace field carries it",
    () =>
      Effect.gen(function* measure() {
        const coverage = yield* Effect.all([
          recorded(
            "Greenhouse",
            greenhousePostings("greenhouse:acme", "acme"),
            { jobs: [greenhouseJob] }
          ),
          recorded("Lever", leverPostings("lever:acme", "acme"), [
            leverPosting,
          ]),
          recorded("Ashby", ashbyPostings("ashby:acme", "acme"), ashbyBoard),
          recorded(
            "SmartRecruiters",
            smartRecruitersPostings("smartrecruiters:acme", "acme"),
            smartRecruitersServiceNow
          ),
          recorded(
            "Workable",
            workablePostings("workable:acme", "acme"),
            workableHuggingface
          ),
        ]);

        expect(coverage).toStrictEqual([
          { board: "Greenhouse", postings: 1, remote: 0, salary: 0 },
          { board: "Lever", postings: 1, remote: 1, salary: 1 },
          { board: "Ashby", postings: 2, remote: 2, salary: 1 },
          { board: "SmartRecruiters", postings: 2, remote: 1, salary: 0 },
          { board: "Workable", postings: 2, remote: 2, salary: 0 },
        ]);
      })
  );

  it.effect(
    "a Lever range labelled as on-target earnings is not a base salary band",
    () =>
      Effect.gen(function* readLever() {
        const postings = yield* leverPostings("lever:acme", "acme");

        expect(postings.map((posting) => posting.salaryBand)).toStrictEqual([
          undefined,
        ]);
      }).pipe(
        Effect.provide(
          replay([
            {
              ...leverPosting,
              salaryDescriptionPlain: "The range below is on-target earnings.",
            },
          ])
        )
      )
  );
});
