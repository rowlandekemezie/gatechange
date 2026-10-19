import { Effect, Option, Schema } from "effect";

const ProviderCause = Schema.Struct({
  code: Schema.String,
});

export interface SendFailure {
  readonly _tag: string;
  readonly cause?: unknown;
}

export const logSendFailure = ({ _tag, cause }: SendFailure) => {
  const provider = Schema.decodeUnknownOption(ProviderCause)(cause);

  return Effect.logError("magic link send failed").pipe(
    Effect.annotateLogs({
      causeCode: Option.match(provider, {
        onNone: () => "unknown",
        onSome: ({ code }) => code,
      }),
      errorTag: _tag,
    })
  );
};
