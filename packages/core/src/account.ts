import { Context, Data, Effect, Schema } from "effect";

import { Unauthorized } from "./unauthorized.js";

export const MAGIC_LINK_TTL_MINUTES = 15;

export const ACCOUNT_PATH = "/account";

export const PRICING_PATH = "/pricing";

const RETURN_PATH = /^\/(?![/\\])[^\s\\]*$/u;

export const returnPathOf = (raw: string | null | undefined): string =>
  raw !== null && raw !== undefined && RETURN_PATH.test(raw)
    ? raw
    : ACCOUNT_PATH;

export const SIGN_IN_EMAIL_CAPACITY_CODE = "SIGN_IN_EMAIL_CAPACITY";

export const UNAUTHORIZED_MESSAGE =
  "Unauthorized: this needs a signed-in member. Sign in on the site, or send a Pro member's agent token from the account page as Authorization: Bearer <token>.";

export const proNeededMessage = (pricing: string) =>
  `Pro needed: this tool needs Gate Change Pro, and the connected account does not have it. Tell the user they can get Pro at ${pricing}. listJobs, getJob and boardStats stay free.`;

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
  FreeHolder: { readonly pricing: string };
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
      Effect.fail(new Unauthorized({ message: UNAUTHORIZED_MESSAGE })),
    FreeHolder: ({ pricing }) =>
      Effect.fail(new Unauthorized({ message: proNeededMessage(pricing) })),
    Member: ({ account }) => Effect.succeed(account),
  });
});
