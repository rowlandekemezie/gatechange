import { Account, SocialProvider } from "@rat-stack/core/contracts";
import { Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

export const SessionState = defineTaggedUnion({
  Checking: {},
  SignedIn: { account: Account },
  SignedOut: {},
});

export type SessionStateValue = typeof SessionState.Type;

export const SignInState = defineTaggedUnion({
  Editing: { email: Schema.String, problem: Schema.Option(Schema.String) },
  Sending: { email: Schema.String },
  Sent: { email: Schema.String },
});

export type SignInStateValue = typeof SignInState.Type;

export const LinkOutcome = Schema.Literals(["Sent", "Invalid", "Failed"]);

export type LinkOutcomeValue = typeof LinkOutcome.Type;

export const Model = Schema.Struct({
  session: SessionState,
  signIn: SignInState,
  socialProviders: Schema.Array(SocialProvider),
});

export type ModelValue = typeof Model.Type;

export const editing = (email: string, problem?: string) =>
  SignInState.Editing({ email, problem: Option.fromNullishOr(problem) });
