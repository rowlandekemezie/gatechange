import { describe, expect, it } from "@effect/vitest";
import { FeedUnavailable } from "@rat-stack/core";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { smartRecruitersPostings, workablePostings } from "../src/index.js";
import smartRecruitersServiceNow from "./fixtures/smartrecruiters-servicenow.json" with { type: "json" };
import workableHuggingface from "./fixtures/workable-huggingface.json" with { type: "json" };

type RecordedBoard =
  | typeof smartRecruitersServiceNow
  | typeof workableHuggingface;

const serve = (respond: (url: URL) => object) => {
  const requested: string[] = [];

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requested.push(request.url);

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(respond(new URL(request.url)))
        )
      );
    })
  );

  return { layer, requested };
};

const replay = (recorded: RecordedBoard) => serve(() => recorded);

const listedBoard = (totalFound: number, listed: number) =>
  serve((url) => {
    const offset = Number(url.searchParams.get("offset"));

    return {
      content: Array.from(
        { length: Math.max(0, Math.min(100, listed - offset)) },
        (_, index) => ({
          company: { identifier: "Acme" },
          id: `${offset + index}`,
          name: `Engineering Manager ${offset + index}`,
        })
      ),
      totalFound,
    };
  });

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
          "https://api.smartrecruiters.com/v1/companies/ServiceNow/postings?offset=0&limit=100",
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

  it.effect(
    "a SmartRecruiters board over one page is read in full, page by page",
    () => {
      const { layer, requested } = listedBoard(250, 250);

      return Effect.gen(function* readEveryPage() {
        const postings = yield* smartRecruitersPostings(
          "smartrecruiters:Acme",
          "Acme"
        );

        expect(requested).toStrictEqual(
          [0, 100, 200].map(
            (offset) =>
              `https://api.smartrecruiters.com/v1/companies/Acme/postings?offset=${offset}&limit=100`
          )
        );
        expect(postings.map((posting) => posting.externalId)).toStrictEqual(
          Array.from({ length: 250 }, (_, index) => `${index}`)
        );
      }).pipe(Effect.provide(layer));
    }
  );

  it.effect(
    "a SmartRecruiters board over the posting cap fails instead of replacing the feed with a partial list",
    () => {
      const { layer, requested } = listedBoard(941, 941);

      return Effect.gen(function* refuseOverCap() {
        const failure = yield* Effect.flip(
          smartRecruitersPostings("smartrecruiters:Acme", "Acme")
        );

        expect(failure).toBeInstanceOf(FeedUnavailable);
        expect(requested).toStrictEqual([
          "https://api.smartrecruiters.com/v1/companies/Acme/postings?offset=0&limit=100",
        ]);
      }).pipe(Effect.provide(layer));
    }
  );

  it.effect(
    "a SmartRecruiters board that returns fewer postings than it counts fails",
    () => {
      const { layer, requested } = listedBoard(250, 200);

      return Effect.gen(function* refuseShortRead() {
        const failure = yield* Effect.flip(
          smartRecruitersPostings("smartrecruiters:Acme", "Acme")
        );

        expect(failure).toBeInstanceOf(FeedUnavailable);
        expect(requested).toStrictEqual(
          [0, 100, 200].map(
            (offset) =>
              `https://api.smartrecruiters.com/v1/companies/Acme/postings?offset=${offset}&limit=100`
          )
        );
      }).pipe(Effect.provide(layer));
    }
  );

  it.effect(
    "an unknown SmartRecruiters company, listed as zero postings, is unavailable",
    () => {
      const { layer } = listedBoard(0, 0);

      return Effect.gen(function* refuseEmptyCompany() {
        const failure = yield* Effect.flip(
          smartRecruitersPostings("smartrecruiters:Acme", "Acme")
        );

        expect(failure).toBeInstanceOf(FeedUnavailable);
      }).pipe(Effect.provide(layer));
    }
  );
});
