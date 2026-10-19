import { UNSUBSCRIBE_PATH } from "./digest-email.js";

export type UnsubscribeState = "Confirm" | "Done" | "Invalid" | "Unavailable";

export interface UnsubscribePage {
  readonly html: string;
  readonly status: number;
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const page = (title: string, body: string) =>
  [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>body{margin:0;padding:24px 16px;font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#111;background:#fff}main{max-width:480px;margin:0 auto}button{font:inherit;padding:10px 16px;border-radius:6px;border:1px solid #1a56db;background:#1a56db;color:#fff;cursor:pointer}a{color:#1a56db}@media (prefers-color-scheme:dark){body{color:#eee;background:#111}a{color:#8ab4ff}}</style>",
    `</head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
  ].join("");

const pages: Record<UnsubscribeState, (token: string) => UnsubscribePage> = {
  Confirm: (token) => ({
    html: page(
      "Stop weekly digests?",
      `<p>You will stop getting the weekly email for your saved searches. Your searches stay on your account.</p><form method="post" action="${escapeHtml(`${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`)}"><button type="submit">Unsubscribe</button></form>`
    ),
    status: 200,
  }),
  Done: () => ({
    html: page(
      "You are unsubscribed",
      '<p>We will not send you the weekly digest again. Save a search on <a href="/">the board</a> to turn it back on.</p>'
    ),
    status: 200,
  }),
  Invalid: () => ({
    html: page(
      "This link does not work",
      '<p>The unsubscribe link is incomplete or was changed. Open the newest digest email and use its link, or manage your searches on <a href="/account">your account</a>.</p>'
    ),
    status: 400,
  }),
  Unavailable: (token) => ({
    html: page(
      "Try again in a minute",
      `<p>We could not save your choice just now. Nothing changed yet.</p><form method="post" action="${escapeHtml(`${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`)}"><button type="submit">Try again</button></form>`
    ),
    status: 503,
  }),
};

export const unsubscribePage = (
  state: UnsubscribeState,
  token: string
): UnsubscribePage => pages[state](token);
