import type { BetterAuthPlugin, DBAdapter, Where } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { Option, Schema } from "effect";

export const EMAIL_SEND_LIMIT = { max: 3, windowSeconds: 15 * 60 } as const;

const WINDOW_MILLIS = EMAIL_SEND_LIMIT.windowSeconds * 1000;

const RACE_RETRIES = 3;

const MODEL = "rateLimit";

interface RateLimitRow {
  readonly lastRequest: number | bigint;
}

const GMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
]);

const SignInBody = Schema.Struct({ email: Schema.String });

export const emailSendKey = (email: string) => {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");

  if (at === -1) {
    return `magic-link-email:${address}`;
  }

  const [tagless = ""] = address.slice(0, at).split("+");
  const domain = address.slice(at + 1);
  const gmail = GMAIL_DOMAINS.has(domain);
  const mailbox = gmail ? tagless.replaceAll(".", "") : tagless;

  return `magic-link-email:${mailbox}@${gmail ? "gmail.com" : domain}`;
};

// @effect-diagnostics-next-line asyncFunction:off -- better-auth's adapter is Promise-based, and this mirrors its own database rate limiter.
const consumeSend = async (
  adapter: DBAdapter,
  key: string,
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
        { field: "count", operator: "lt", value: EMAIL_SEND_LIMIT.max },
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
    : await consumeSend(adapter, key, now, retries - 1);
};

const keepSendRowsForTheWindow = {
  max: EMAIL_SEND_LIMIT.max,
  pathMatcher: () => false,
  window: EMAIL_SEND_LIMIT.windowSeconds,
};

export const emailSendLimit = (): BetterAuthPlugin => ({
  hooks: {
    before: [
      {
        // @effect-diagnostics-next-line asyncFunction:off -- better-auth hooks are Promise-returning middleware.
        handler: createAuthMiddleware(async (ctx) => {
          const body = Schema.decodeUnknownOption(SignInBody)(ctx.body);

          if (Option.isNone(body)) {
            return;
          }

          const allowed = await consumeSend(
            ctx.context.adapter,
            emailSendKey(body.value.email),
            // @effect-diagnostics-next-line globalDate:off -- better-auth's limiter rows are stamped with the same wall clock.
            Date.now()
          );

          if (!allowed) {
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "Too many sign-in links were sent to this address.",
            });
          }
        }),
        matcher: (context) => context.path === "/sign-in/magic-link",
      },
    ],
  },
  id: "email-send-limit",
  rateLimit: [keepSendRowsForTheWindow],
});
