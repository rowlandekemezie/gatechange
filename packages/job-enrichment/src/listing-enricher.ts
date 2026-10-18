import {
  EnricherUnavailable,
  ListingEnricher,
  ModelAnswer,
} from "@rat-stack/core";
import type { PostingRequest } from "@rat-stack/core";
import { Config, Effect, Layer, Schema } from "effect";

export const DEFAULT_ENRICHMENT_MODEL =
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const enrichmentModel = Config.String("ENRICHMENT_MODEL").pipe(
  Config.withDefault(DEFAULT_ENRICHMENT_MODEL)
);

export const MAX_ANSWER_TOKENS = 256;

export const modelAnswerJsonSchema = Schema.toJsonSchemaDocument(ModelAnswer, {
  onExcessProperty: "error",
}).schema;

export const SYSTEM_PROMPT = [
  "You read one job posting and extract facts about the role as JSON.",
  "Extract only what the posting states. Use null for anything it does not state.",
  "Never estimate, infer or convert a salary.",
  "Give salary amounts exactly as written in the posting, with their period (Year, Month or Hour) and their ISO 4217 currency code.",
  "When the posting lists several salary ranges, for example by location, zone or level, give the first range it states.",
  "If the posting states a salary amount, salaryMin and salaryMax must be numbers. For a single amount, give it as both.",
  "seniority is the level of the role itself.",
  "remotePolicy says where the person in this role works. Remote: fully remote from anywhere. RemoteInRegion: fully remote but only from named countries or regions. Hybrid: some days a week in an office; occasional office visits or meetups do not make a role Hybrid. Onsite: in an office every working day. Use null when the posting does not say. A city or office location alone is not a remote policy, and experience with remote teams is not one either.",
  "reportsTo is the title of the person this role reports to, only when the posting says the role reports to them. Working or partnering with someone is not reporting to them.",
  "teamSize is the number of people this role will manage, only when the posting states it. A required number of people managed in past jobs is not the team size.",
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

export const chatRequestOf = (posting: PostingRequest): ChatRequest => ({
  max_tokens: MAX_ANSWER_TOKENS,
  messages: [
    { content: SYSTEM_PROMPT, role: "system" },
    {
      content: `Company: ${posting.company}\nTitle: ${posting.title}\n\n${posting.text}`,
      role: "user",
    },
  ],
  response_format: { json_schema: modelAnswerJsonSchema, type: "json_schema" },
  temperature: 0,
});

const ModelOutput = Schema.Struct({
  response: Schema.Union([
    Schema.fromJsonString(Schema.Unknown),
    Schema.Unknown,
  ]),
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
              Effect.map(({ response }) => response),
              Effect.orElseSucceed(() => null)
            )
          )
        ),
      model: options.model,
    })
  );
