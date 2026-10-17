import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { smartRecruitersPostings, workablePostings } from "../src/index.js";
import smartRecruitersServiceNow from "./fixtures/smartrecruiters-servicenow.json" with { type: "json" };
import workableHuggingface from "./fixtures/workable-huggingface.json" with { type: "json" };

type RecordedBoard =
  | typeof smartRecruitersServiceNow
  | typeof workableHuggingface;

const replay = (recorded: RecordedBoard) => {
  const requested: string[] = [];

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requested.push(request.url);

      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(recorded))
      );
    })
  );

  return { layer, requested };
};

describe("recorded company boards", () => {
  it.effect(
    "a Workable board keeps every well-formed job and skips a malformed one",
    () => {
      const { layer, requested } = replay(workableHuggingface);

      return Effect.gen(function* readWorkable() {
        const postings = yield* workablePostings(
          "workable:huggingface",
          "huggingface"
        );

        expect(requested).toStrictEqual([
          "https://apply.workable.com/api/v1/widget/accounts/huggingface",
        ]);
        expect(postings).toStrictEqual([
          {
            company: "",
            externalId: "81B46579FE",
            location: "Paris, Île-de-France, France",
            postedAt: Date.parse("2026-05-29"),
            salary: null,
            title: "Open-Source Machine Learning Engineer - EMEA Remote",
            url: "https://apply.workable.com/j/81B46579FE",
            workplace: "Remote",
          },
          {
            company: "",
            externalId: "19A136F8E2",
            location: "New York, United States",
            postedAt: Date.parse("2026-05-29"),
            salary: null,
            title: "Open-Source Machine Learning Engineer - US Remote",
            url: "https://apply.workable.com/j/19A136F8E2",
            workplace: "Remote",
          },
        ]);
      }).pipe(Effect.provide(layer));
    }
  );

  it.effect(
    "a SmartRecruiters board keeps every well-formed posting and skips a malformed one",
    () => {
      const { layer, requested } = replay(smartRecruitersServiceNow);

      return Effect.gen(function* readSmartRecruiters() {
        const postings = yield* smartRecruitersPostings(
          "smartrecruiters:ServiceNow",
          "ServiceNow"
        );

        expect(requested).toStrictEqual([
          "https://api.smartrecruiters.com/v1/companies/ServiceNow/postings?limit=100",
        ]);
        expect(postings).toStrictEqual([
          {
            company: "",
            externalId: "744000156092859",
            location: "Santa Clara, CALIFORNIA, United States",
            postedAt: Date.parse("2026-10-16T23:13:22.307Z"),
            salary: null,
            title: "Sr Software Engineering Manager - Veza",
            url: "https://jobs.smartrecruiters.com/ServiceNow/744000156092859",
            workplace: "Unspecified",
          },
          {
            company: "",
            externalId: "744000156092899",
            location: "Radomlje, SLOVENIA, Slovenia",
            postedAt: Date.parse("2026-10-16T23:14:22.975Z"),
            salary: null,
            title: "Sr Software Engineer - Veza",
            url: "https://jobs.smartrecruiters.com/ServiceNow/744000156092899",
            workplace: "Remote",
          },
        ]);
      }).pipe(Effect.provide(layer));
    }
  );
});
