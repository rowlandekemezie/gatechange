export { makeAccountStore, SESSION_COOKIE } from "./account-store.js";

export type { SessionLookup, SessionUser } from "./account-store.js";

export { EMAIL_SEND_LIMIT } from "./email-send-limit.js";

export { magicLinkEmail } from "./magic-link-email.js";

export type { MagicLinkEmail } from "./magic-link-email.js";

export { authOptions, isAuthPath } from "./options.js";

export {
  authSecret,
  CrossSiteRequest,
  MIN_AUTH_SECRET_LENGTH,
  viewerOfRequest,
} from "./request-viewer.js";

export type {
  AuthSettings,
  MagicLinkRequest,
  SocialCredentials,
} from "./options.js";
