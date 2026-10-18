export { makeAccountStore, SESSION_COOKIE } from "./account-store.js";

export type { SessionLookup, SessionUser } from "./account-store.js";

export { EMAIL_SEND_LIMIT, emailSendKey } from "./email-send-limit.js";

export { magicLinkEmail } from "./magic-link-email.js";

export type { MagicLinkEmail } from "./magic-link-email.js";

export { AUTH_BASE_PATH, authOptions } from "./options.js";

export {
  authSecret,
  MIN_AUTH_SECRET_LENGTH,
  viewerOfCookie,
} from "./request-viewer.js";

export type {
  AuthSettings,
  MagicLinkRequest,
  SocialCredentials,
} from "./options.js";
