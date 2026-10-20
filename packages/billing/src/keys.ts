import { PROD_STAGE } from "@rat-stack/core";
import { Data, Option, Redacted } from "effect";

export type StripeMode = "live" | "test";

export const stripeModeOf = (stage: string): StripeMode =>
  stage === PROD_STAGE ? "live" : "test";

const STRIPE_KEY = /^(?<kind>sk|rk)_(?<mode>live|test)_/u;

interface StripeApiKey {
  readonly restricted: boolean;
  readonly mode: StripeMode;
}

const parseKey = (key: Redacted.Redacted): Option.Option<StripeApiKey> => {
  const groups = STRIPE_KEY.exec(Redacted.value(key))?.groups;

  return groups === undefined
    ? Option.none()
    : Option.some({
        mode: groups.mode === "live" ? "live" : "test",
        restricted: groups.kind === "rk",
      });
};

export class StripeKeyRefused extends Data.TaggedError("StripeKeyRefused")<{
  readonly message: string;
}> {}

export interface StripeKeys {
  readonly account: Option.Option<Redacted.Redacted>;
  readonly worker: Option.Option<Redacted.Redacted>;
}

const modeMismatch = (name: string, key: StripeApiKey, stage: string) =>
  `${name} is a ${key.mode}-mode key, but stage ${stage} sells in ${stripeModeOf(stage)} mode.`;

const profileRefusal = (
  stage: string,
  account: Option.Option<Redacted.Redacted>
): Option.Option<string> =>
  account.pipe(
    Option.flatMap((value) =>
      Option.match(parseKey(value), {
        onNone: () =>
          Option.some(
            "The Alchemy Stripe profile key is not an sk_ or rk_ Stripe key."
          ),
        onSome: (key) =>
          key.mode === stripeModeOf(stage)
            ? Option.none()
            : Option.some(
                modeMismatch("The Alchemy Stripe profile key", key, stage)
              ),
      })
    )
  );

const workerRefusal = (
  stage: string,
  worker: Option.Option<Redacted.Redacted>
): Option.Option<string> => {
  const live = stripeModeOf(stage) === "live";

  if (Option.isNone(worker)) {
    return live
      ? Option.some(
          `Stage ${stage} sells Pro only with STRIPE_RESTRICTED_KEY set to an rk_live_ restricted key, so the Worker never holds the account secret.`
        )
      : Option.none();
  }

  return Option.match(parseKey(worker.value), {
    onNone: () => Option.some("STRIPE_RESTRICTED_KEY is not a Stripe API key."),
    onSome: (key) => {
      if (key.mode !== stripeModeOf(stage)) {
        return Option.some(modeMismatch("STRIPE_RESTRICTED_KEY", key, stage));
      }

      return live && !key.restricted
        ? Option.some(
            `Stage ${stage} needs a restricted rk_live_ key in STRIPE_RESTRICTED_KEY, not a secret key.`
          )
        : Option.none();
    },
  });
};

export const stripeKeyRefusal = (
  stage: string,
  keys: StripeKeys
): Option.Option<StripeKeyRefused> =>
  profileRefusal(stage, keys.account).pipe(
    Option.orElse(() => workerRefusal(stage, keys.worker)),
    Option.map((message) => new StripeKeyRefused({ message }))
  );
