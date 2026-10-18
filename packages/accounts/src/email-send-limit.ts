import type { BetterAuthPlugin, DBAdapter, Where } from "better-auth";
import { APIError } from "better-auth/api";
import type { MagicLinkOptions } from "better-auth/plugins";

import type { MagicLinkRequest } from "./options.js";

export const EMAIL_SEND_LIMIT = {
  attempts: 6,
  max: 3,
  windowSeconds: 15 * 60,
} as const;

const WINDOW_MILLIS = EMAIL_SEND_LIMIT.windowSeconds * 1000;

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

const inboxOf = (email: string) => {
  const address = email.toLowerCase();
  const at = address.lastIndexOf("@");

  if (!GMAIL_DOMAINS.has(address.slice(at + 1))) {
    return address;
  }

  const [tagless = ""] = address.slice(0, at).split("+");

  return `${tagless.replaceAll(".", "")}@gmail.com`;
};

// @effect-diagnostics-next-line asyncFunction:off -- better-auth's adapter is Promise-based, and this mirrors its own database rate limiter.
const consume = async (
  adapter: DBAdapter,
  key: string,
  max: number,
  now: number,
  retries = RACE_RETRIES
): Promise<boolean> => {
  const keyIs: Where = { field: "key", value: key };

  const row = await adapter.findOne<RateLimitRow>({
    model: MODEL,
    where: [keyIs],
  });

  if (row !== null && now - Number(row.lastRequest) < WINDOW_MILLIS) {
    const counted = await adapter.incrementOne({
      increment: { count: 1 },
      model: MODEL,
      set: { lastRequest: now },
      where: [
        keyIs,
        { field: "lastRequest", operator: "gt", value: now - WINDOW_MILLIS },
        { field: "count", operator: "lt", value: max },
      ],
    });

    return counted !== null;
  }

  const claimed =
    row === null
      ? await adapter
          .create({ data: { count: 1, key, lastRequest: now }, model: MODEL })
          .then(
            () => true,
            () => false
          )
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
    : await consume(adapter, key, max, now, retries - 1);
};

const keepSendRowsForTheWindow = {
  max: EMAIL_SEND_LIMIT.max,
  pathMatcher: () => false,
  window: EMAIL_SEND_LIMIT.windowSeconds,
};

export const emailSendLimit = (): BetterAuthPlugin => ({
  id: "email-send-limit",
  rateLimit: [keepSendRowsForTheWindow],
});

export const limitSends =
  (
    send: (request: MagicLinkRequest) => Promise<void>
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
    const sendKey = `magic-link-email:${inbox}`;
    // @effect-diagnostics-next-line globalDate:off -- better-auth's limiter rows are stamped with the same wall clock.
    const now = Date.now();

    const allowed =
      (await consume(
        adapter,
        `magic-link-attempt:${inbox}`,
        EMAIL_SEND_LIMIT.attempts,
        now
      )) && (await consume(adapter, sendKey, EMAIL_SEND_LIMIT.max, now));

    if (!allowed) {
      throw new APIError("TOO_MANY_REQUESTS", {
        message: "Too many sign-in links were sent to this address.",
      });
    }

    try {
      await send({ email, url });
    } catch (error) {
      await adapter.incrementOne({
        increment: { count: -1 },
        model: MODEL,
        where: [
          { field: "key", value: sendKey },
          { field: "count", operator: "gt", value: 0 },
        ],
      });

      throw error;
    }
  };
