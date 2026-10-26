import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_DAILY_NEURONS,
  EnricherUnavailable,
  ListingEnricher,
  ModelAnswer,
} from "@rat-stack/core";
import type { PostingRequest } from "@rat-stack/core";
import { ConfigProvider, Effect, Schema } from "effect";

import {
  chatRequestOf,
  DEFAULT_ENRICHMENT_MODEL,
  enrichmentModel,
  listingEnricherLayer,
  MAX_INPUT_TOKENS,
  MAX_NEURONS,
  MIN_NEURONS,
  modelAnswerJsonSchema,
  neuronsFor,
  PROMPT_TOKEN_FLOOR,
  SYSTEM_PROMPT,
} from "../src/index.js";
import type { ChatRequest, RunModel } from "../src/index.js";

const posting: PostingRequest = {
  company: "Acme",
  salary: null,
  text: "Lead a team of 8. Salary $200,000 - $240,000 USD per year.",
  title: "Engineering Manager",
  workplace: "Remote",
};

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

const inputBytesOf = (request: PostingRequest) => {
  const chat = chatRequestOf(request);

  return (
    utf8Bytes(SYSTEM_PROMPT) +
    utf8Bytes(chat.messages[1]?.content ?? "") +
    utf8Bytes(JSON.stringify(chat.response_format))
  );
};

const answer = {
  handsOn: null,
  handsOnQuote: null,
  remotePolicy: "Remote",
  remotePolicyQuote: null,
  reportsTo: "VP Engineering",
  reportsToQuote: null,
  salaryMax: 240_000,
  salaryMin: 200_000,
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

        expect(result).toStrictEqual({ answer, neurons: null });
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
          content: `Company: Acme\nTitle: Engineering Manager\nWorkplace type: Remote\n\n${posting.text}`,
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
        yield* Schema.decodeUnknownEffect(ModelAnswer)(result.answer)
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

        expect(result.answer).toBe("I cannot help with that");
        expect(Schema.is(ModelAnswer)(result.answer)).toBe(false);
      })
  );

  it.effect(
    "turns the token usage Workers AI reports into neurons, and reports none when usage is missing",
    () =>
      Effect.gen(function* reportedUsage() {
        const reported = yield* extractWith(
          recording(
            Effect.succeed({
              response: answer,
              usage: {
                completion_tokens: 100,
                prompt_tokens: 1000,
                total_tokens: 1100,
              },
            })
          ).run
        );

        expect(reported.neurons).toBe(48);
      })
  );

  it.effect.each<readonly [string, number, number]>([
    ["no prompt tokens", 0, 100],
    ["negative prompt tokens", -50, 100],
    ["negative completion tokens", 1000, -50],
    ["fractional prompt tokens", 1000.5, 100],
    ["fractional completion tokens", 1000, 0.5],
    [
      "fewer prompt tokens than the system-text lower bound",
      PROMPT_TOKEN_FLOOR - 1,
      100,
    ],
  ])(
    "treats a usage report with %s as missing, so the call keeps its full claim",
    ([, promptTokens, completionTokens]) =>
      Effect.gen(function* untrustedUsage() {
        const reported = yield* extractWith(
          recording(
            Effect.succeed({
              response: answer,
              usage: {
                completion_tokens: completionTokens,
                prompt_tokens: promptTokens,
              },
            })
          ).run
        );

        expect(reported).toStrictEqual({ answer, neurons: null });
      })
  );

  it.effect.each([PROMPT_TOKEN_FLOOR, PROMPT_TOKEN_FLOOR + 69])(
    "accepts a system-text usage report of %s without counting schema or template tokens",
    (promptTokens) =>
      Effect.gen(function* systemOnlyUsage() {
        const reported = yield* extractWith(
          recording(
            Effect.succeed({
              response: answer,
              usage: { completion_tokens: 0, prompt_tokens: promptTokens },
            })
          ).run
        );

        expect(reported.neurons).toBe(Math.ceil(promptTokens * 0.026668));
      })
  );

  it.effect(
    "trusts a report at the prompt token floor and no report below the neurons that floor implies",
    () =>
      Effect.gen(function* atFloor() {
        const reported = yield* extractWith(
          recording(
            Effect.succeed({
              response: answer,
              usage: {
                completion_tokens: 0,
                prompt_tokens: PROMPT_TOKEN_FLOOR,
              },
            })
          ).run
        );

        expect(reported.neurons).toBe(MIN_NEURONS);
        expect(MIN_NEURONS).toBeGreaterThan(0);
      })
  );

  it("keeps the prompt token floor under the smallest prompt Workers AI reported in the round 11 eval", () => {
    expect(PROMPT_TOKEN_FLOOR).toBeGreaterThan(0);
    expect(PROMPT_TOKEN_FLOOR).toBeLessThan(953);
  });

  it("names the ATS workplace type to the model only when the board states one", () => {
    expect(
      chatRequestOf({ ...posting, workplace: "Unspecified" }).messages[1]
        ?.content
    ).toBe(`Company: Acme\nTitle: Engineering Manager\n\n${posting.text}`);
  });

  it.each([
    ["a short English posting", posting.text],
    ["1 MB of English", "Lead the platform team. ".repeat(44_000)],
    ["1 MB of Chinese", "负责平台团队。".repeat(150_000)],
    ["1 MB of emoji", "🚀".repeat(250_000)],
  ])(
    "bounds %s to the input token budget, so its claimed neurons never exceed the per-call ceiling",
    (_label, text) => {
      const request = { ...posting, text };
      const content = chatRequestOf(request).messages[1]?.content ?? "";

      expect(inputBytesOf(request)).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
      expect(neuronsFor(request)).toBeLessThanOrEqual(MAX_NEURONS);
      expect(
        content.startsWith("Company: Acme\nTitle: Engineering Manager")
      ).toBe(true);
      expect(content).not.toMatch(/\p{Cs}/u);
    }
  );

  it("claims fewer neurons for a short posting than the per-call ceiling", () => {
    expect(neuronsFor(posting)).toBeLessThan(MAX_NEURONS);
  });

  it("keeps a 31-day month at the default daily budget under $10 even when no free neurons are left", () => {
    expect((DEFAULT_DAILY_NEURONS * 31 * 0.011) / 1000).toBeLessThan(10);
  });

  it.each([
    ["a short English posting", posting.text],
    ["a short Chinese posting", "负责平台团队，管理八名工程师。".repeat(100)],
    ["a short emoji posting", "🚀 ".repeat(1000)],
    ["1 MB of English", "Lead the platform team. ".repeat(44_000)],
    ["1 MB of Chinese", "负责平台团队。".repeat(150_000)],
    ["1 MB of emoji", "🚀".repeat(250_000)],
  ])(
    "claims at least what %s can cost: every prompt byte, the chat template and a full answer",
    (_label, text) => {
      const request = { ...posting, text };
      const promptBytes = inputBytesOf(request) + 64;

      const worstCase = Math.ceil(
        promptBytes * (26_668 / 1_000_000) + 256 * (204_805 / 1_000_000)
      );

      expect(neuronsFor(request)).toBeGreaterThanOrEqual(worstCase);
    }
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
