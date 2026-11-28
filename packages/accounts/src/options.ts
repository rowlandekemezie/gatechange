import { MAGIC_LINK_TTL_MINUTES, SocialProvider } from "@rat-stack/core";
import type { SiteHosts, SocialProviderValue } from "@rat-stack/core";
import type {
  BetterAuthOptions,
  BetterAuthPlugin,
  GenericEndpointContext,
} from "better-auth";
import { magicLink } from "better-auth/plugins";
import { Option, Schema } from "effect";

import { authLogger } from "./auth-logger.js";
import { sameOriginRateRules, sameSiteVerify } from "./cross-site.js";
import { emailSendLimit, limitSends } from "./email-send-limit.js";
import { hashLinkToken, magicLinkPreview } from "./link-preview.js";
import { mcpOAuth } from "./oauth.js";
import type { McpResourcePlugin } from "./oauth.js";

const AUTH_BASE_PATH = "/api/auth";

export const isAuthPath = (url: string) => {
  const pathname = URL.parse(`http://backend.invalid${url}`)?.pathname ?? "";

  return (
    pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`)
  );
};

export interface SocialCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface MagicLinkRequest {
  readonly email: string;
  readonly url: string;
}

export interface AuthMilestone {
  readonly account: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly kind: "SignedIn" | "SignedUp";
  readonly method: string;
}

export interface AuthSettings {
  readonly hosts: SiteHosts;
  readonly magicLinkDailySendLimit?: number;
  readonly reached?: (milestone: AuthMilestone) => Promise<void>;
  readonly sendMagicLink: (request: MagicLinkRequest) => Promise<void>;
  readonly social: Partial<Record<SocialProviderValue, SocialCredentials>>;
}

export type AuthOptions = Omit<BetterAuthOptions, "plugins"> & {
  readonly plugins: [...BetterAuthPlugin[], McpResourcePlugin];
};

const MAGIC_LINK_VERIFY_PATH = "/magic-link/verify";

const SOCIAL_CALLBACK_PATH = "/callback/";

const methodOf = (context: GenericEndpointContext | null) => {
  if (context?.path === MAGIC_LINK_VERIFY_PATH) {
    return "email";
  }

  return context?.path.startsWith(SOCIAL_CALLBACK_PATH) === true
    ? Option.getOrElse(
        Schema.decodeUnknownOption(SocialProvider)(context.params?.id),
        () => "other"
      )
    : "other";
};

// @effect-diagnostics-next-line asyncFunction:off -- better-auth awaits Promise-returning database hooks.
const reach = async (
  settings: AuthSettings,
  kind: AuthMilestone["kind"],
  account: string,
  context: GenericEndpointContext | null
) => {
  await settings
    .reached?.({
      account,
      headers: Object.fromEntries(context?.headers ?? []),
      kind,
      method: methodOf(context),
    })
    .catch((error: unknown) => {
      context?.context.logger.warn("auth milestone not reported", error);
    });
};

export const authOptions = (settings: AuthSettings): AuthOptions => ({
  account: { encryptOAuthTokens: true },
  advanced: {
    database: { joins: true, validateSchema: false },
    disableOriginCheck: false,
    ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    useSecureCookies: true,
  },
  basePath: AUTH_BASE_PATH,
  baseURL: {
    allowedHosts: [...settings.hosts.allowedHosts],
    ...Option.match(settings.hosts.fallbackOrigin, {
      onNone: () => ({}),
      onSome: (fallback) => ({ fallback }),
    }),
    protocol: settings.hosts.protocol,
  },
  databaseHooks: {
    session: {
      create: {
        // @effect-diagnostics-next-line asyncFunction:off -- better-auth awaits Promise-returning database hooks.
        after: async (session, context) => {
          await reach(settings, "SignedIn", session.userId, context);
        },
      },
    },
    user: {
      create: {
        // @effect-diagnostics-next-line asyncFunction:off -- better-auth awaits Promise-returning database hooks.
        after: async (user, context) => {
          await reach(settings, "SignedUp", user.id, context);
        },
      },
    },
  },
  logger: authLogger,
  plugins: [
    magicLink({
      expiresIn: MAGIC_LINK_TTL_MINUTES * 60,
      sendMagicLink: limitSends(
        settings.sendMagicLink,
        settings.magicLinkDailySendLimit
      ),
      storeToken: { hash: hashLinkToken, type: "custom-hasher" },
    }),
    magicLinkPreview(),
    emailSendLimit(),
    sameSiteVerify(),
    ...mcpOAuth(),
  ],
  rateLimit: {
    customRules: { "/get-session": false, ...sameOriginRateRules },
    enabled: true,
    storage: "database",
  },
  socialProviders: settings.social,
  telemetry: { enabled: false },
});
