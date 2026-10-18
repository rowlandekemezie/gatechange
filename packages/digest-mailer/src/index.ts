import { DigestMailer, DigestMailerUnavailable } from "@rat-stack/core";
import { Effect, Predicate } from "effect";
import type { Redacted } from "effect";

import { digestEmail } from "./digest-email.js";
import type { DigestEmail } from "./digest-email.js";
import { unsubscribeToken } from "./unsubscribe-token.js";

export {
  digestEmail,
  jobLink,
  UNSUBSCRIBE_PATH,
  unsubscribeLink,
} from "./digest-email.js";

export type { DigestEmail, DigestLinks } from "./digest-email.js";

export { unsubscribePage } from "./unsubscribe-page.js";

export type { UnsubscribePage, UnsubscribeState } from "./unsubscribe-page.js";

export {
  unsubscribeToken,
  verifyUnsubscribeToken,
} from "./unsubscribe-token.js";

export interface SendFailure {
  readonly cause?: unknown;
  readonly message: string;
}

export interface DigestMailerSettings {
  readonly secret: Redacted.Redacted;
  readonly send: (email: DigestEmail) => Effect.Effect<unknown, SendFailure>;
  readonly sender: string;
  readonly siteOrigin: string;
}

export const QUOTA_ERROR_CODES: ReadonlySet<string> = new Set([
  "E_DAILY_LIMIT_EXCEEDED",
  "E_RATE_LIMIT_EXCEEDED",
]);

const codeOf = (failure: SendFailure) =>
  Predicate.hasProperty(failure.cause, "code") &&
  Predicate.isString(failure.cause.code)
    ? failure.cause.code
    : "";

export const isQuotaFailure = (failure: SendFailure) =>
  QUOTA_ERROR_CODES.has(codeOf(failure)) ||
  [...QUOTA_ERROR_CODES].some((code) => failure.message.includes(code));

export const makeDigestMailer = (settings: DigestMailerSettings) =>
  DigestMailer.of({
    send: (digest) =>
      unsubscribeToken(settings.secret, digest.account).pipe(
        Effect.flatMap((token) =>
          settings.send(
            digestEmail(settings.sender, digest, {
              siteOrigin: settings.siteOrigin,
              unsubscribeToken: token,
            })
          )
        ),
        Effect.mapError(
          (failure) =>
            new DigestMailerUnavailable({
              message: `${codeOf(failure)} ${failure.message}`
                .trim()
                .slice(0, 500),
              quotaExhausted: isQuotaFailure(failure),
            })
        ),
        Effect.asVoid
      ),
  });
