import { describe, expect, it } from "@effect/vitest";
import {
  EnricherUnavailable,
  ListingEnricher,
  ModelAnswer,
} from "@rat-stack/core";
import { ConfigProvider, Effect, Schema } from "effect";

import {
  DEFAULT_ENRICHMENT_MODEL,
  enrichmentModel,
  listingEnricherLayer,
  modelAnswerJsonSchema,
} from "../src/index.js";
import type { ChatRequest, RunModel } from "../src/index.js";

const posting = {
  company: "Acme",
  text: "Lead a team of 8. Salary $200,000 - $240,000 USD per year.",
  title: "Engineering Manager",
};

const answer = {
  remotePolicy: "Remote",
  reportsTo: "VP Engineering",
  salaryCurrency: "USD",
  salaryMax: 240_000,
  salaryMin: 200_000,
  salaryPeriod: "Year",
  seniority: "Manager",
  teamSize: 8,
  teamSizeQuote: "Lead a team of 8.",
};

const ObjectSchema = Schema.Struct({
  additionalProperties: Schema.Boolean,
  properties: Schema.Record(Schema.String, Schema.Unknown),
  required: Schema.Array(Schema.String),
  type: Schema.String,
});

const recording = (output: Effect.Effect<unknown, { message: string }>) => {
  const calls: { model: string; request: ChatRequest }[] = [];

  const run: RunModel = (model, request) => {
    calls.push({ model, request });

    return output;
  };

  return { calls, run };
};

const extractWith = (run: RunModel) =>
  Effect.gen(function* extract() {
    const enricher = yield* ListingEnricher;

    return yield* enricher.extract(posting);
  }).pipe(
    Effect.provide(
      listingEnricherLayer({ model: DEFAULT_ENRICHMENT_MODEL, run })
    )
  );

describe("listing enricher", () => {
  it("derives a JSON Schema that names every ModelAnswer key", () => {
    const keys = Object.keys(ModelAnswer.fields).toSorted();

    const objectSchema = Schema.decodeUnknownSync(ObjectSchema)(
      modelAnswerJsonSchema
    );

    expect(objectSchema.type).toBe("object");
    expect(objectSchema.additionalProperties).toBe(false);
    expect(Object.keys(objectSchema.properties).toSorted()).toStrictEqual(keys);
    expect(objectSchema.required.toSorted()).toStrictEqual(keys);
  });

  it.effect(
    "sends the posting in JSON mode at temperature 0 to the configured model",
    () => {
      const fake = recording(Effect.succeed({ response: answer }));

      return Effect.gen(function* sendPosting() {
        const result = yield* extractWith(fake.run);
        const [call] = fake.calls;

        expect(result).toStrictEqual(answer);
        expect(call?.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
        expect(call?.request.temperature).toBe(0);
        expect(call?.request.response_format).toStrictEqual({
          json_schema: modelAnswerJsonSchema,
          type: "json_schema",
        });
        expect(call?.request.messages[0]?.role).toBe("system");
        expect(call?.request.messages[0]?.content).toContain("null");
        expect(call?.request.messages[0]?.content).toContain("Never estimate");
        expect(call?.request.messages[1]).toStrictEqual({
          content: `Company: Acme\nTitle: Engineering Manager\n\n${posting.text}`,
          role: "user",
        });
      });
    }
  );

  it.effect("parses a response that arrives as a JSON string", () =>
    Effect.gen(function* parseString() {
      const result = yield* extractWith(
        recording(Effect.succeed({ response: JSON.stringify(answer) })).run
      );

      expect(
        yield* Schema.decodeUnknownEffect(ModelAnswer)(result)
      ).toStrictEqual(answer);
    })
  );

  it.effect(
    "returns an unparseable string as is so core marks it Malformed",
    () =>
      Effect.gen(function* keepGarbage() {
        const result = yield* extractWith(
          recording(Effect.succeed({ response: "I cannot help with that" })).run
        );

        expect(result).toBe("I cannot help with that");
        expect(Schema.is(ModelAnswer)(result)).toBe(false);
      })
  );

  it.effect("reports a Workers AI failure as EnricherUnavailable", () =>
    Effect.gen(function* failRun() {
      const failure = yield* Effect.flip(
        extractWith(
          recording(Effect.fail({ message: "JSON Mode couldn't be met" })).run
        ).pipe(Effect.asVoid)
      );

      expect(failure).toStrictEqual(
        new EnricherUnavailable({ message: "JSON Mode couldn't be met" })
      );
    })
  );

  it.effect("reads the model from ENRICHMENT_MODEL with a default", () =>
    Effect.gen(function* readModel() {
      const unset = yield* enrichmentModel.parse(
        ConfigProvider.fromUnknown({})
      );

      const set = yield* enrichmentModel.parse(
        ConfigProvider.fromUnknown({ ENRICHMENT_MODEL: "@cf/missing/model" })
      );

      expect(unset).toBe(DEFAULT_ENRICHMENT_MODEL);
      expect(set).toBe("@cf/missing/model");
    })
  );
});
