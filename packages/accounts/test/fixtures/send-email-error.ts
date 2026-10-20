import { Data } from "effect";

export class SendEmailError extends Data.TaggedError("SendEmailError")<{
  readonly cause?: unknown;
  readonly code?: string;
  readonly message: string;
  readonly recipient?: string;
}> {}
