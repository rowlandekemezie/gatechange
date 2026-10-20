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
  readonly unsubscribeTokenVersion?: string;
}

export const QUOTA_ERROR_CODES: ReadonlySet<string> = new Set([
  "E_DAILY_LIMIT_EXCEEDED",
  "E_RATE_LIMIT_EXCEEDED",
]);

const DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  ...QUOTA_ERROR_CODES,
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_SENDER_NOT_VERIFIED",
]);

const codeOf = (failure: SendFailure) =>
  Predicate.hasProperty(failure.cause, "code") &&
  Predicate.isString(failure.cause.code)
    ? failure.cause.code
    : "";

export const isQuotaFailure = (failure: SendFailure) =>
  QUOTA_ERROR_CODES.has(codeOf(failure));

export const makeDigestMailer = (settings: DigestMailerSettings) =>
  DigestMailer.of({
    send: (digest) =>
      unsubscribeToken(
        settings.secret,
        digest.account,
        settings.unsubscribeTokenVersion
      ).pipe(
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
              message: DIAGNOSTIC_CODES.has(codeOf(failure))
                ? `Email sending failed (${codeOf(failure)})`
                : "Email sending failed",
              quotaExhausted: isQuotaFailure(failure),
            })
        ),
        Effect.asVoid
      ),
  });
