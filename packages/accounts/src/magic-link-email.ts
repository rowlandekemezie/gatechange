import { MAGIC_LINK_TTL_SECONDS } from "./options.js";
import type { MagicLinkRequest } from "./options.js";

export interface MagicLinkEmail {
  readonly from: string;
  readonly html: string;
  readonly subject: string;
  readonly text: string;
  readonly to: string;
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const magicLinkEmail = (
  from: string,
  { email, url }: MagicLinkRequest
): MagicLinkEmail => {
  const minutes = MAGIC_LINK_TTL_SECONDS / 60;

  return {
    from,
    html: [
      "<p>Use this link to sign in to the engineering leadership job board:</p>",
      `<p><a href="${escapeHtml(url)}">Sign in</a></p>`,
      `<p>The link works once and expires in ${minutes} minutes. If you did not ask for it, ignore this email.</p>`,
    ].join(""),
    subject: "Your sign-in link",
    text: [
      "Use this link to sign in to the engineering leadership job board:",
      "",
      url,
      "",
      `The link works once and expires in ${minutes} minutes. If you did not ask for it, ignore this email.`,
    ].join("\n"),
    to: email,
  };
};
