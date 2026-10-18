import { MAGIC_LINK_TTL_MINUTES } from "@rat-stack/core";
import type { SiteHosts, SocialProviderValue } from "@rat-stack/core";
import type { BetterAuthOptions } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { Option } from "effect";

import { sameSiteVerify } from "./cross-site.js";
import { emailSendLimit, limitSends } from "./email-send-limit.js";

const AUTH_BASE_PATH = "/api/auth";

export const isAuthPath = (url: string) => {
  const { pathname } = new URL(url, "http://backend.invalid");

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

export interface AuthSettings {
  readonly hosts: SiteHosts;
  readonly sendMagicLink: (request: MagicLinkRequest) => Promise<void>;
  readonly social: Partial<Record<SocialProviderValue, SocialCredentials>>;
}

export const authOptions = (settings: AuthSettings): BetterAuthOptions => ({
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
  },
  plugins: [
    magicLink({
      expiresIn: MAGIC_LINK_TTL_MINUTES * 60,
      sendMagicLink: limitSends(settings.sendMagicLink),
      storeToken: "hashed",
    }),
    emailSendLimit(),
    sameSiteVerify(),
  ],
  rateLimit: {
    customRules: { "/get-session": false },
    enabled: true,
    storage: "database",
  },
  socialProviders: settings.social,
  telemetry: { enabled: false },
});
