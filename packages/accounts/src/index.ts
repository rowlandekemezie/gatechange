export { makeAccountStore, SESSION_COOKIE } from "./account-store.js";

export type { SessionLookup, SessionUser } from "./account-store.js";

export { magicLinkEmail } from "./magic-link-email.js";

export type { MagicLinkEmail } from "./magic-link-email.js";

export { AUTH_BASE_PATH, authOptions } from "./options.js";

export type {
  AuthSettings,
  MagicLinkRequest,
  SocialCredentials,
} from "./options.js";
