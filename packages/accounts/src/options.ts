import type { SocialProviderValue } from "@rat-stack/core";
import type { BetterAuthOptions } from "better-auth";
import { magicLink } from "better-auth/plugins";

export const AUTH_BASE_PATH = "/api/auth";

export const MAGIC_LINK_TTL_SECONDS = 15 * 60;

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
  basePath: AUTH_BASE_PATH,
  baseURL: {
    allowedHosts: [...settings.allowedHosts],
    fallback: settings.fallbackOrigin,
  },
  plugins: [
    magicLink({
      expiresIn: MAGIC_LINK_TTL_SECONDS,
      // @effect-diagnostics-next-line asyncFunction:off -- better-auth's magic link plugin awaits a Promise-returning sender.
      sendMagicLink: async ({ email, url }) => {
        await settings.sendMagicLink({ email, url });
      },
    }),
  ],
  socialProviders: settings.social,
  telemetry: { enabled: false },
});
