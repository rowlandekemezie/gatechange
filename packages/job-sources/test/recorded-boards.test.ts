import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { workablePostings } from "../src/index.js";
import workableHuggingface from "./fixtures/workable-huggingface.json" with { type: "json" };

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

const replay = (recorded: typeof workableHuggingface) => serve(() => recorded);

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
});
