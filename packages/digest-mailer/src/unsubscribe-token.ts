import { AccountId } from "@rat-stack/core";
import type { AccountIdValue } from "@rat-stack/core";
import { Effect, Option, pipe, Redacted, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";

const KEY_PURPOSE = "rat-stack digest unsubscribe key v1";

const encoder = new TextEncoder();

const hmacKey = (secret: Uint8Array, usages: ("sign" | "verify")[]) =>
  Effect.promise(
    // @effect-diagnostics-next-line asyncFunction:off -- WebCrypto only exposes Promise-returning HMAC operations.
    async () =>
      await crypto.subtle.importKey(
        "raw",
        new Uint8Array(secret),
        { hash: "SHA-256", name: "HMAC" },
        false,
        usages
      )
  );

type HmacKey = Effect.Success<ReturnType<typeof hmacKey>>;

const sign = (key: HmacKey, data: string) =>
  Effect.promise(
    // @effect-diagnostics-next-line asyncFunction:off -- WebCrypto only exposes Promise-returning HMAC operations.
    async () => await crypto.subtle.sign("HMAC", key, encoder.encode(data))
  ).pipe(Effect.map((signature) => new Uint8Array(signature)));

const derivedKey = Effect.fn("unsubscribeKey")(function* derive(
  secret: Redacted.Redacted
) {
  const root = yield* hmacKey(encoder.encode(Redacted.value(secret)), ["sign"]);

  return yield* hmacKey(yield* sign(root, KEY_PURPOSE), ["sign", "verify"]);
});

export const unsubscribeToken = Effect.fn("unsubscribeToken")(function* token(
  secret: Redacted.Redacted,
  account: AccountIdValue
) {
  const signature = yield* sign(yield* derivedKey(secret), account);

  return `${Base64Url.encode(account)}.${Base64Url.encode(signature)}`;
});

const decodeAccount = Schema.decodeUnknownOption(AccountId);

const partsOf = (token: string) => {
  const [encodedAccount, encodedSignature, ...rest] = token.split(".");

  if (
    encodedAccount === undefined ||
    encodedSignature === undefined ||
    rest.length > 0
  ) {
    return Option.none();
  }

  return pipe(
    Result.getSuccess(Base64Url.decodeString(encodedAccount)),
    Option.flatMap(decodeAccount),
    Option.flatMap((account) =>
      pipe(
        Result.getSuccess(Base64Url.decode(encodedSignature)),
        Option.map((signature) => ({ account, signature }))
      )
    )
  );
};

export const verifyUnsubscribeToken = Effect.fn("verifyUnsubscribeToken")(
  function* verify(secret: Redacted.Redacted, token: string) {
    const parts = partsOf(token);

    if (Option.isNone(parts)) {
      return Option.none<AccountIdValue>();
    }

    const { account, signature } = parts.value;
    const key = yield* derivedKey(secret);

    const valid = yield* Effect.promise(
      // @effect-diagnostics-next-line asyncFunction:off -- WebCrypto only exposes Promise-returning HMAC operations.
      async () =>
        await crypto.subtle.verify(
          "HMAC",
          key,
          new Uint8Array(signature),
          encoder.encode(account)
        )
    );

    return valid ? Option.some(account) : Option.none<AccountIdValue>();
  }
);
