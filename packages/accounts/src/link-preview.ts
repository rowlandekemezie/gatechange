import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { Option, Schema } from "effect";
import { Base64Url } from "effect/encoding";

export const MAGIC_LINK_PREVIEW_PATH = "/magic-link/preview";

const LINK_PREVIEW_LIMIT = { max: 10, windowSeconds: 60 } as const;

const decodePendingLink = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      email: Schema.String,
      type: Schema.Literal("magic-link"),
    })
  )
);

interface VerificationRow {
  readonly expiresAt: Date;
  readonly value: string;
}

// @effect-diagnostics-next-line asyncFunction:off -- better-auth awaits a Promise-returning hasher.
export const hashLinkToken = async (token: string) =>
  Base64Url.encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
    )
  );

export const magicLinkPreview = (): BetterAuthPlugin => ({
  endpoints: {
    magicLinkPreview: createAuthEndpoint(
      MAGIC_LINK_PREVIEW_PATH,
      { method: "GET" },
      // @effect-diagnostics-next-line asyncFunction:off -- better-auth endpoints are Promise-returning handlers.
      async (ctx) => {
        const token = String(ctx.query?.token ?? "");

        const row = await ctx.context.adapter.findOne<VerificationRow>({
          model: "verification",
          where: [
            {
              field: "identifier",
              value: `magic-link:${await hashLinkToken(token)}`,
            },
          ],
        });

        const pending =
          // @effect-diagnostics-next-line globalDate:off -- better-auth stamps verification rows with the same wall clock.
          row === null || new Date(row.expiresAt).getTime() <= Date.now()
            ? Option.none()
            : decodePendingLink(row.value);

        if (Option.isNone(pending)) {
          throw new APIError("NOT_FOUND");
        }

        ctx.setHeader("cache-control", "no-store");

        return await ctx.json({ email: pending.value.email });
      }
    ),
  },
  id: "magic-link-preview",
  rateLimit: [
    {
      max: LINK_PREVIEW_LIMIT.max,
      pathMatcher: (path) => path === MAGIC_LINK_PREVIEW_PATH,
      window: LINK_PREVIEW_LIMIT.windowSeconds,
    },
  ],
});
