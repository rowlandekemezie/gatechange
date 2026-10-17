import { Context, Data, Effect, Schema } from "effect";

import { Unauthorized } from "./unauthorized.js";

export const AccountId = Schema.NonEmptyString.pipe(Schema.brand("AccountId"));

export type AccountIdValue = typeof AccountId.Type;

export const Account = Schema.Struct({
  email: Schema.String,
  id: AccountId,
  name: Schema.String,
});

export type AccountValue = typeof Account.Type;

export const SocialProvider = Schema.Literals(["github", "google"]);

export type SocialProviderValue = typeof SocialProvider.Type;

export const SignInOptions = Schema.Struct({
  socialProviders: Schema.Array(SocialProvider),
});

export type SignInOptionsValue = typeof SignInOptions.Type;

export type ViewerValue = Data.TaggedEnum<{
  Anonymous: Record<never, never>;
  Member: { readonly account: AccountValue };
}>;

export const Viewer = Data.taggedEnum<ViewerValue>();

export class CurrentViewer extends Context.Service<
  CurrentViewer,
  ViewerValue
>()("@rat-stack/core/CurrentViewer") {}

export const currentMember = Effect.gen(function* currentMember() {
  const viewer = yield* CurrentViewer;

  return yield* Viewer.$match(viewer, {
    Anonymous: () =>
      Effect.fail(
        new Unauthorized({ message: "Sign in to see your account." })
      ),
    Member: ({ account }) => Effect.succeed(account),
  });
});
