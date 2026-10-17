import { MAGIC_LINK_TTL_MINUTES } from "@rat-stack/core";
import type { SocialProviderValue } from "@rat-stack/core";
import type { BetterAuthOptions } from "better-auth";
import { magicLink } from "better-auth/plugins";

export const AUTH_BASE_PATH = "/api/auth";

export interface SocialCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface MagicLinkRequest {
  readonly email: string;
  readonly url: string;
}

export interface AuthSettings {
  readonly allowedHosts: readonly string[];
  readonly fallbackOrigin: string;
  readonly sendMagicLink: (request: MagicLinkRequest) => Promise<void>;
  readonly social: Partial<Record<SocialProviderValue, SocialCredentials>>;
}

export const authOptions = (settings: AuthSettings): BetterAuthOptions => ({
  account: { encryptOAuthTokens: true },
  advanced: {
    ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    useSecureCookies: true,
  },
  basePath: AUTH_BASE_PATH,
  baseURL: {
    allowedHosts: [...settings.allowedHosts],
    fallback: settings.fallbackOrigin,
  },
  plugins: [
    magicLink({
      expiresIn: MAGIC_LINK_TTL_MINUTES * 60,
      sendMagicLink: settings.sendMagicLink,
      storeToken: "hashed",
    }),
  ],
  rateLimit: { enabled: true, storage: "database" },
  socialProviders: settings.social,
  telemetry: { enabled: false },
});
