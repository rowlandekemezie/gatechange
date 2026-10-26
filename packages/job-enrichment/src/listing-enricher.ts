import {
  EnricherUnavailable,
  ListingEnricher,
  ModelAnswer,
} from "@rat-stack/core";
import type { ModelReply, PostingRequest } from "@rat-stack/core";
import { Config, Effect, Layer, Schema } from "effect";

export const DEFAULT_ENRICHMENT_MODEL =
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const enrichmentModel = Config.String("ENRICHMENT_MODEL").pipe(
  Config.withDefault(DEFAULT_ENRICHMENT_MODEL)
);

export const MAX_ANSWER_TOKENS = 320;

export const MAX_INPUT_TOKENS = 16_000;

export const NEURONS_PER_INPUT_TOKEN = 26_668 / 1_000_000;

export const NEURONS_PER_OUTPUT_TOKEN = 204_805 / 1_000_000;

export const CHAT_TEMPLATE_TOKENS = 64;

export const modelAnswerJsonSchema = Schema.toJsonSchemaDocument(ModelAnswer, {
  onExcessProperty: "error",
}).schema;

export const SYSTEM_PROMPT = [
  "You read one job posting and extract facts about the role as JSON.",
  "Extract only what the posting states. Use null for anything it does not state.",
  "Never estimate, infer or convert a salary.",
  "Give base salary amounts exactly as written in the posting, as numbers. Equity, bonus, stipends, budgets and retirement plans such as a 401k are not salary.",
  "When the posting lists several salary ranges, for example by location, zone or level, give the first range it states.",
  "If the posting states a salary amount, salaryMin and salaryMax must be numbers. For a single amount, give it as both.",
  "seniority is the level of the role itself.",
  "remotePolicy says where the person in this role works. Remote: fully remote from anywhere. RemoteInRegion: fully remote but only from named countries or regions. Hybrid: some days a week in an office; occasional office visits or meetups do not make a role Hybrid. Onsite: in an office every working day. Use null when the posting does not say. A city, country or office location alone is not a remote policy, travel is not one, and experience with remote teams is not one either. remotePolicyQuote is the exact words of the posting that state the policy.",
  "reportsTo is the job title of the person this role reports to, without their name, only when the posting says the role reports to them. Working or partnering with someone is not reporting to them. reportsToQuote is the exact words of the posting that say whom the role reports to.",
  "teamSize is the number of people this role will manage once hired, only when the posting states it. A count of teams, projects or customers is not a number of people. teamSizeQuote is the exact words of the posting that state it. A requirement on the candidate, such as how many people they must have led before, is never the team size: use null for both.",
  "handsOn is how much coding the person in this role does, only when the posting states it. None: the posting says the role does not write code. Some: the role codes part of the time, such as reviews, prototypes or occasional changes. Significant: the posting says the role writes code as a large part of the job. Past coding experience asked of the candidate is not handsOn. handsOnQuote is the exact words of the posting that state it. If the posting does not say, use null for both.",
].join("\n");

export interface ChatMessage {
  readonly content: string;
  readonly role: "system" | "user";
}

export interface ChatRequest {
  readonly max_tokens: number;
  readonly messages: readonly ChatMessage[];
  readonly response_format: {
    readonly json_schema: typeof modelAnswerJsonSchema;
    readonly type: "json_schema";
  };
  readonly temperature: number;
}

export type RunModel = (
  model: string,
  request: ChatRequest
) => Effect.Effect<unknown, { readonly message: string }>;

const utf8 = new TextEncoder();

const bytesOf = (text: string) => utf8.encode(text).length;

const withinBytes = (text: string, budget: number) =>
  text.slice(
    0,
    utf8.encodeInto(text, new Uint8Array(Math.max(0, budget))).read
  );

const responseFormat = {
  json_schema: modelAnswerJsonSchema,
  type: "json_schema",
} as const;

const fixedInputTokens =
  bytesOf(SYSTEM_PROMPT) +
  bytesOf(JSON.stringify(responseFormat)) +
  CHAT_TEMPLATE_TOKENS;

const letterRunsOf = (text: string) => text.match(/\p{L}+/gu)?.length ?? 0;

export const PROMPT_TOKEN_FLOOR = letterRunsOf(SYSTEM_PROMPT);

const inputTokensOf = (request: ChatRequest) =>
  fixedInputTokens + bytesOf(request.messages[1]?.content ?? "");

const neuronsOf = (inputTokens: number, outputTokens: number) =>
  Math.ceil(
    inputTokens * NEURONS_PER_INPUT_TOKEN +
      outputTokens * NEURONS_PER_OUTPUT_TOKEN
  );

const headerOf = (posting: PostingRequest) =>
  [
    `Company: ${posting.company}`,
    `Title: ${posting.title}`,
    ...(posting.workplace === "Unspecified"
      ? []
      : [`Workplace type: ${posting.workplace}`]),
  ].join("\n");

export const chatRequestOf = (posting: PostingRequest): ChatRequest => ({
  max_tokens: MAX_ANSWER_TOKENS,
  messages: [
    { content: SYSTEM_PROMPT, role: "system" },
    {
      content: withinBytes(
        `${headerOf(posting)}\n\n${posting.text}`,
        MAX_INPUT_TOKENS - fixedInputTokens
      ),
      role: "user",
    },
  ],
  response_format: responseFormat,
  temperature: 0,
});

export const neuronsFor = (posting: PostingRequest) =>
  neuronsOf(inputTokensOf(chatRequestOf(posting)), MAX_ANSWER_TOKENS);

export const MAX_NEURONS = neuronsOf(MAX_INPUT_TOKENS, MAX_ANSWER_TOKENS);

export const MIN_NEURONS = neuronsOf(PROMPT_TOKEN_FLOOR, 0);

const reportedNeurons = (usage: {
  readonly completion_tokens: number;
  readonly prompt_tokens: number;
}) =>
  Number.isSafeInteger(usage.completion_tokens) &&
  Number.isSafeInteger(usage.prompt_tokens) &&
  usage.completion_tokens >= 0 &&
  usage.prompt_tokens >= PROMPT_TOKEN_FLOOR
    ? neuronsOf(usage.prompt_tokens, usage.completion_tokens)
    : null;

const ModelOutput = Schema.Struct({
  response: Schema.Union([
    Schema.fromJsonString(Schema.Unknown),
    Schema.Unknown,
  ]),
  usage: Schema.optional(
    Schema.Struct({
      completion_tokens: Schema.Finite,
      prompt_tokens: Schema.Finite,
    })
  ),
});

export const listingEnricherLayer = (options: {
  readonly model: string;
  readonly run: RunModel;
}) =>
  Layer.succeed(
    ListingEnricher,
    ListingEnricher.of({
      extract: (posting) =>
        options.run(options.model, chatRequestOf(posting)).pipe(
          Effect.mapError(
            (failure) =>
              new EnricherUnavailable({
                message: failure.message.slice(0, 500),
              })
          ),
          Effect.flatMap((output) =>
            Schema.decodeUnknownEffect(ModelOutput)(output).pipe(
              Effect.map(({ response, usage }): ModelReply => ({
                answer: response,
                neurons: usage === undefined ? null : reportedNeurons(usage),
              })),
              Effect.orElseSucceed((): ModelReply => ({
                answer: null,
                neurons: null,
              }))
            )
          )
        ),
      maxNeurons: MAX_NEURONS,
      minNeurons: MIN_NEURONS,
      model: options.model,
      neuronsFor,
    })
  );
