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

export const CLIENT_DAILY_SEND_LIMIT = 5;

export const CLIENT_DAILY_REFUND_LIMIT = 3;

export const INBOX_DAILY_SEND_LIMIT = 6;

const NEW_ADDRESS_SHARE = 0.4;

export const newAddressDailySendLimit = (dailySendLimit: number) =>
  Math.ceil(dailySendLimit * NEW_ADDRESS_SHARE);

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

// @effect-diagnostics-next-line asyncFunction:off -- better-auth's adapter is Promise-based.
const refundClient = async (
  adapter: DBAdapter,
  clientKey: string,
  clientRefundKey: string,
  now: number
) => {
  const allowed = await consume(
    adapter,
    clientRefundKey,
    CLIENT_DAILY_REFUND_LIMIT,
    now,
    DAY_MILLIS
  );

  if (allowed) {
    await refund(adapter, clientKey);
  }
};

interface Claim {
  readonly key: string;
}

interface DailyBudget extends Claim {
  readonly max: number;
  readonly refusal: string | undefined;
}

const CAPACITY_REFUSAL =
  "Sign-in email capacity is temporarily unavailable. Please try again later.";

// @effect-diagnostics-next-line asyncFunction:off -- better-auth's adapter is Promise-based.
const refundBudgets = async (adapter: DBAdapter, claims: readonly Claim[]) => {
  await Promise.allSettled(
    claims.map(
      // @effect-diagnostics-next-line asyncFunction:off -- better-auth's adapter is Promise-based.
      async ({ key }) => {
        await refund(adapter, key);
      }
    )
  );
};

// @effect-diagnostics-next-line asyncFunction:off -- better-auth's adapter is Promise-based.
const fitsBudget = async (
  adapter: DBAdapter,
  { key, max }: DailyBudget,
  now: number,
  claimed: readonly Claim[]
) => {
  try {
    return await consume(adapter, key, max, now, DAY_MILLIS);
  } catch (error) {
    await refundBudgets(adapter, claimed);

    throw error;
  }
};

// @effect-diagnostics-next-line asyncFunction:off -- better-auth's adapter is Promise-based.
const claimBudgets = async (
  adapter: DBAdapter,
  budgets: readonly DailyBudget[],
  now: number,
  claimed: readonly Claim[]
): Promise<DailyBudget | undefined> => {
  const [next, ...rest] = budgets;

  if (next === undefined) {
    return undefined;
  }

  if (await fitsBudget(adapter, next, now, claimed)) {
    return await claimBudgets(adapter, rest, now, [...claimed, next]);
  }

  if (next.refusal !== undefined) {
    await refundBudgets(adapter, claimed);
  }

  return next;
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
    const clientRefundKey = `magic-link-client-refund:${day}:${client}`;
    const inboxDayKey = `magic-link-inbox:${day}:${inbox}`;

    const owner = await ctx.context.internalAdapter.findUserByEmail(email);
    const isMember = owner?.user.emailVerified === true;

    const allowed =
      (await consume(adapter, attemptKey, EMAIL_SEND_LIMIT.attempts, now)) &&
      (await consume(adapter, sendKey, EMAIL_SEND_LIMIT.max, now));

    if (!allowed) {
      throw new APIError("TOO_MANY_REQUESTS", {
        message: "Too many sign-in links were sent to this address.",
      });
    }

    const siteBudgets: readonly DailyBudget[] = [
      ...(isMember
        ? []
        : [
            {
              key: `magic-link-new:${day}`,
              max: newAddressDailySendLimit(dailySendLimit),
              refusal: CAPACITY_REFUSAL,
            },
          ]),
      {
        key: `magic-link-global:${day}`,
        max: dailySendLimit,
        refusal: CAPACITY_REFUSAL,
      },
    ];

    const budgets: readonly DailyBudget[] = [
      {
        key: clientKey,
        max: CLIENT_DAILY_SEND_LIMIT,
        refusal:
          "Too many sign-in links were requested from this network today.",
      },
      ...siteBudgets,
      ...(isMember
        ? []
        : [
            {
              key: inboxDayKey,
              max: INBOX_DAILY_SEND_LIMIT,
              refusal: undefined,
            },
          ]),
    ];

    const refused = await claimBudgets(adapter, budgets, now, [
      { key: sendKey },
      { key: attemptKey },
    ]);

    if (refused?.refusal !== undefined) {
      throw new APIError("TOO_MANY_REQUESTS", { message: refused.refusal });
    }

    if (refused !== undefined) {
      await refundBudgets(adapter, siteBudgets);

      ctx.context.logger.warn(
        "magic link dropped: inbox with no verified account reached its daily cap"
      );

      return;
    }

    try {
      await send({ email, url });
    } catch (error) {
      await refund(adapter, sendKey);

      if (!isMember) {
        await refund(adapter, inboxDayKey);
      }

      const code = Schema.is(CodedSendError)(error) ? error.cause.code : "";

      if (REJECTED_SEND_CODES.has(code)) {
        await refundBudgets(adapter, siteBudgets);
      }

      if (PROVIDER_FAILURES.has(code)) {
        await refund(adapter, attemptKey);
        await refundClient(adapter, clientKey, clientRefundKey, now);
      }

      ctx.context.logger.error("magic link send failed", error);

      throw new APIError("INTERNAL_SERVER_ERROR", {
        message: "Unable to send the sign-in link.",
      });
    }
  };
