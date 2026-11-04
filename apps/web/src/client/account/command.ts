import { SocialProvider } from "@rat-stack/core/contracts";
import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import { load } from "foldkit/navigation";

import { JobQueries } from "../board/queries.js";
import { AuthClient } from "./auth-client.js";
import { Message } from "./message.js";

export const FetchSession = Command.define("FetchSession", {
  execute: AuthClient.use((auth) => auth.currentAccount).pipe(
    Effect.orElseSucceed(() => Option.none()),
    Effect.map((account) => Message.CompletedFetchSession({ account }))
  ),
  messages: [Message.CompletedFetchSession],
});

export const FetchSignInOptions = Command.define("FetchSignInOptions", {
  execute: JobQueries.use((queries) => queries.signInOptions).pipe(
    Effect.match({
      onFailure: () =>
        Message.CompletedFetchSignInOptions({ socialProviders: [] }),
      onSuccess: ({ socialProviders }) =>
        Message.CompletedFetchSignInOptions({ socialProviders }),
    })
  ),
  messages: [Message.CompletedFetchSignInOptions],
});

export const PreviewLink = Command.define("PreviewLink", {
  args: { token: Schema.String },
  execute: ({ token }) =>
    AuthClient.use((auth) => auth.previewLink(token)).pipe(
      Effect.map((preview) => Message.CompletedPreviewLink({ preview }))
    ),
  messages: [Message.CompletedPreviewLink],
});

export const RequestLink = Command.define("RequestLink", {
  args: { email: Schema.String },
  execute: ({ email }) =>
    AuthClient.use((auth) => auth.requestLink(email)).pipe(
      Effect.map((outcome) => Message.CompletedRequestLink({ email, outcome }))
    ),
  messages: [Message.CompletedRequestLink],
});

export const StartSocialSignIn = Command.define("StartSocialSignIn", {
  args: { provider: SocialProvider },
  execute: ({ provider }) =>
    AuthClient.use((auth) => auth.socialRedirect(provider)).pipe(
      Effect.flatMap(load),
      Effect.match({
        onFailure: () => Message.FailedSocialSignIn({ provider }),
        onSuccess: () => Message.CompletedSocialRedirect(),
      })
    ),
  messages: [Message.FailedSocialSignIn, Message.CompletedSocialRedirect],
});

export const SignOut = Command.define("SignOut", {
  execute: AuthClient.use((auth) => auth.signOut).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedSignOut())
  ),
  messages: [Message.CompletedSignOut],
});
