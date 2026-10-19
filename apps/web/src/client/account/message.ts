import { Account, SocialProvider } from "@rat-stack/core/contracts";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { LinkOutcome } from "./model.js";

export const Message = defineMessageUnion({
  ClickedSignOut: {},
  ClickedSocialSignIn: { provider: SocialProvider },
  ClickedUseAnotherEmail: {},
  CompletedFetchSession: { account: Schema.Option(Account) },
  CompletedFetchSignInOptions: {
    socialProviders: Schema.Array(SocialProvider),
  },
  CompletedRequestLink: { email: Schema.String, outcome: LinkOutcome },
  CompletedSignOut: {},
  CompletedSocialRedirect: {},
  FailedSocialSignIn: { provider: SocialProvider },
  SubmittedSignIn: {},
  UpdatedSignInEmail: { value: Schema.String },
});

export type MessageValue = typeof Message.Type;
