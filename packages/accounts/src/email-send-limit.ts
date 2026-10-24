import type { BetterAuthPlugin, DBAdapter, Where } from "better-auth";
import { APIError, getIP } from "better-auth/api";
import type { MagicLinkOptions } from "better-auth/plugins";
import { DateTime, Schema } from "effect";

import type { MagicLinkRequest } from "./options.js";

export const EMAIL_SEND_LIMIT = {
  attempts: 6,
  max: 3,
  windowSeconds: 15 * 60,
} as const;

const WINDOW_MILLIS = EMAIL_SEND_LIMIT.windowSeconds * 1000;

export const DEFAULT_MAGIC_LINK_DAILY_SEND_LIMIT = 900;

export const CLIENT_DAILY_SEND_LIMIT = 20;

const DAY_MILLIS = 24 * 60 * 60 * 1000;

const REJECTED_SEND_CODES: ReadonlySet<string> = new Set([
  "E_DAILY_LIMIT_EXCEEDED",
  "E_RATE_LIMIT_EXCEEDED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_SENDER_NOT_VERIFIED",
]);

const RACE_RETRIES = 3;

const MAX_ADDRESS_LENGTH = 254;

const MODEL = "rateLimit";

interface RateLimitRow {
  readonly lastRequest: number | bigint;
}

const GMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
]);

const PROVIDER_FAILURES: ReadonlySet<string> = new Set([
  "E_DAILY_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR",
  "E_RATE_LIMIT_EXCEEDED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_SENDER_NOT_VERIFIED",
]);

const CodedSendError = Schema.Struct({
  cause: Schema.Struct({ code: Schema.String }),
});

export const inboxOf = (email: string) => {
  const address = email.toLowerCase();
  const at = address.lastIndexOf("@");
  const domain = address.slice(at + 1);
  const [tagless = ""] = address.slice(0, at).split("+");

  return GMAIL_DOMAINS.has(domain)
    ? `${tagless.replaceAll(".", "")}@gmail.com`
    : `${tagless}@${domain}`;
};

const utcDayOf = (now: number) =>
  DateTime.formatIsoDateUtc(DateTime.makeUnsafe(now));

// @effect-diagnostics-next-line asyncFunction:off -- better-auth's adapter is Promise-based.
const createFirst = async (adapter: DBAdapter, key: string, now: number) => {
  try {
    await adapter.create({
      data: { count: 1, key, lastRequest: now },
      model: MODEL,
    });

    return true;
  } catch (error) {
    const racer = await adapter.findOne<RateLimitRow>({
      model: MODEL,
      where: [{ field: "key", value: key }],
    });

    if (racer === null) {
      throw error;
    }

    return false;
  }
};

// @effect-diagnostics-next-line asyncFunction:off -- better-auth's adapter is Promise-based, and this mirrors its own database rate limiter.
const consume = async (
  adapter: DBAdapter,
  key: string,
  max: number,
  now: number,
  windowMillis = WINDOW_MILLIS,
  retries = RACE_RETRIES
): Promise<boolean> => {
  if (max <= 0) {
    return false;
  }

  const keyIs: Where = { field: "key", value: key };

  const row = await adapter.findOne<RateLimitRow>({
    model: MODEL,
    where: [keyIs],
  });

  if (row !== null && now - Number(row.lastRequest) < windowMillis) {
    const counted = await adapter.incrementOne({
      increment: { count: 1 },
      model: MODEL,
      set: { lastRequest: now },
      where: [
        keyIs,
        { field: "lastRequest", operator: "gt", value: now - windowMillis },
        { field: "count", operator: "lt", value: max },
      ],
    });

    return counted !== null;
  }

  const claimed =
    row === null
      ? await createFirst(adapter, key, now)
      : (await adapter.incrementOne({
          increment: {},
          model: MODEL,
          set: { count: 1, lastRequest: now },
          where: [
            keyIs,
            {
              field: "lastRequest",
              operator: "lte",
              value: Number(row.lastRequest),
            },
          ],
        })) !== null;

  return claimed || retries === 0
    ? claimed
    : await consume(adapter, key, max, now, windowMillis, retries - 1);
};

// @effect-diagnostics-next-line asyncFunction:off -- better-auth's adapter is Promise-based.
const refund = async (adapter: DBAdapter, key: string) => {
  await adapter.incrementOne({
    increment: { count: -1 },
    model: MODEL,
    where: [
      { field: "key", value: key },
      { field: "count", operator: "gt", value: 0 },
    ],
  });
};

const keepSendRowsForTheWindow = {
  max: EMAIL_SEND_LIMIT.max,
  pathMatcher: () => false,
  window: DAY_MILLIS / 1000,
};

export const emailSendLimit = (): BetterAuthPlugin => ({
  id: "email-send-limit",
  rateLimit: [keepSendRowsForTheWindow],
});

export const limitSends =
  (
    send: (request: MagicLinkRequest) => Promise<void>,
    dailySendLimit = DEFAULT_MAGIC_LINK_DAILY_SEND_LIMIT
  ): MagicLinkOptions["sendMagicLink"] =>
  // @effect-diagnostics-next-line asyncFunction:off -- better-auth awaits a Promise-returning sender.
  async ({ email, url }, ctx) => {
    if (email.length > MAX_ADDRESS_LENGTH) {
      throw new APIError("BAD_REQUEST", {
        message: "That email address is too long.",
      });
    }

    if (ctx === undefined) {
      throw new APIError("INTERNAL_SERVER_ERROR");
    }

    const { adapter } = ctx.context;
    const inbox = inboxOf(email);
    const attemptKey = `magic-link-attempt:${inbox}`;
    const sendKey = `magic-link-email:${inbox}`;
    // @effect-diagnostics-next-line globalDate:off -- better-auth's limiter rows are stamped with the same wall clock.
    const now = Date.now();
    const day = utcDayOf(now);
    const source = ctx.request ?? ctx.headers;

    const address =
      source === undefined ? null : getIP(source, ctx.context.options);

    if (address === null) {
      ctx.context.logger.warn(
        "magic link request has no client address; counting it in the shared unknown bucket"
      );
    }

    const client = address ?? "unknown";

    const clientKey = `magic-link-client:${day}:${client}`;
    const globalKey = `magic-link-global:${day}`;

    const allowed =
      (await consume(adapter, attemptKey, EMAIL_SEND_LIMIT.attempts, now)) &&
      (await consume(adapter, sendKey, EMAIL_SEND_LIMIT.max, now));

    if (!allowed) {
      throw new APIError("TOO_MANY_REQUESTS", {
        message: "Too many sign-in links were sent to this address.",
      });
    }

    if (
      !(await consume(
        adapter,
        clientKey,
        CLIENT_DAILY_SEND_LIMIT,
        now,
        DAY_MILLIS
      ))
    ) {
      await refund(adapter, sendKey);
      await refund(adapter, attemptKey);

      throw new APIError("TOO_MANY_REQUESTS", {
        message:
          "Too many sign-in links were requested from this network today.",
      });
    }

    if (!(await consume(adapter, globalKey, dailySendLimit, now, DAY_MILLIS))) {
      await refund(adapter, clientKey);
      await refund(adapter, sendKey);
      await refund(adapter, attemptKey);

      throw new APIError("TOO_MANY_REQUESTS", {
        message:
          "Sign-in email capacity is temporarily unavailable. Please try again later.",
      });
    }

    try {
      await send({ email, url });
    } catch (error) {
      await refund(adapter, sendKey);

      if (
        Schema.is(CodedSendError)(error) &&
        REJECTED_SEND_CODES.has(error.cause.code)
      ) {
        await refund(adapter, globalKey);
        await refund(adapter, clientKey);
      }

      if (
        Schema.is(CodedSendError)(error) &&
        PROVIDER_FAILURES.has(error.cause.code)
      ) {
        await refund(adapter, attemptKey);
      }

      ctx.context.logger.error("magic link send failed", error);

      throw new APIError("INTERNAL_SERVER_ERROR", {
        message: "Unable to send the sign-in link.",
      });
    }
  };
