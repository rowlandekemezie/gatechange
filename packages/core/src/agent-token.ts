import { Context, Effect, Option, Schema } from "effect";
import { Base64Url, Hex } from "effect/encoding";

import type { AccountIdValue, AccountValue } from "./account.js";
import type { JobStoreUnavailable } from "./job-store-unavailable.js";
import { EpochMillis } from "./job.js";

export const MAX_AGENT_TOKENS = 5;

export const MAX_AGENT_TOKEN_LABEL_LENGTH = 60;

export const AGENT_TOKEN_PREFIX = "jobs_pat_";

const SECRET_BYTES = 32;

const ID_BYTES = 16;

export const AgentTokenId = Schema.NonEmptyString.pipe(
  Schema.brand("AgentTokenId")
);

export type AgentTokenIdValue = typeof AgentTokenId.Type;

export const AgentTokenLabel = Schema.Trimmed.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_AGENT_TOKEN_LABEL_LENGTH)
);

export const AgentToken = Schema.Struct({
  createdAt: EpochMillis,
  id: AgentTokenId,
  label: AgentTokenLabel,
});

export type AgentTokenValue = typeof AgentToken.Type;

export const IssuedAgentToken = Schema.Struct({
  secret: Schema.NonEmptyString,
  token: AgentToken,
});

export type IssuedAgentTokenValue = typeof IssuedAgentToken.Type;

export class AgentTokenStore extends Context.Service<
  AgentTokenStore,
  {
    readonly holderOf: (
      secretHash: string
    ) => Effect.Effect<Option.Option<AccountValue>, JobStoreUnavailable>;
    readonly issue: (
      owner: AccountIdValue,
      token: AgentTokenValue,
      secretHash: string,
      limit: number
    ) => Effect.Effect<boolean, JobStoreUnavailable>;
    readonly revoke: (
      owner: AccountIdValue,
      id: AgentTokenIdValue
    ) => Effect.Effect<void, JobStoreUnavailable>;
    readonly tokensOf: (
      owner: AccountIdValue
    ) => Effect.Effect<readonly AgentTokenValue[], JobStoreUnavailable>;
  }
>()("@rat-stack/core/AgentTokenStore") {}

export const secretHashOf = (secret: string) =>
  Effect.promise(
    // @effect-diagnostics-next-line asyncFunction:off -- WebCrypto only exposes a Promise-returning digest.
    async () =>
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
  ).pipe(Effect.map((digest) => Hex.encode(new Uint8Array(digest))));

export const mintAgentSecret = Effect.gen(function* mintAgentSecret() {
  const secret = `${AGENT_TOKEN_PREFIX}${Base64Url.encode(
    crypto.getRandomValues(new Uint8Array(SECRET_BYTES))
  )}`;

  return {
    id: AgentTokenId.make(
      Hex.encode(crypto.getRandomValues(new Uint8Array(ID_BYTES)))
    ),
    secret,
    secretHash: yield* secretHashOf(secret),
  };
});

const BEARER = /^Bearer[ \t]+(?<secret>\S+)[ \t]*$/iu;

export const bearerSecretOf = (
  authorization: string | undefined
): Option.Option<string> =>
  authorization === undefined
    ? Option.none()
    : Option.some(BEARER.exec(authorization)?.groups?.secret ?? "");
