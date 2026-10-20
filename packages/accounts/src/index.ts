export { makeAccountStore, SESSION_COOKIE } from "./account-store.js";

export type { SessionLookup, SessionUser } from "./account-store.js";

export {
  DEFAULT_MAGIC_LINK_DAILY_SEND_LIMIT,
  EMAIL_SEND_LIMIT,
} from "./email-send-limit.js";

export { logSendFailure } from "./send-failure.js";

export { magicLinkEmail } from "./magic-link-email.js";

export type { MagicLinkEmail } from "./magic-link-email.js";

export { authOptions, isAuthPath } from "./options.js";

export {
  authSecret,
  CrossSiteRequest,
  MIN_AUTH_SECRET_LENGTH,
  respondAsViewer,
  viewerOfRequest,
} from "./request-viewer.js";

export type {
  AuthSettings,
  MagicLinkRequest,
  SocialCredentials,
} from "./options.js";
