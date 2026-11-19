import { describe, expect, it } from "@effect/vitest";

import { magicLinkEmail } from "../src/index.js";

const verifyUrl =
  "https://gatechange.dev/api/auth/magic-link/verify?token=abc123&callbackURL=%2Faccount";

const linkFor = (callbackURL: string) =>
  magicLinkEmail("sign-in@gatechange.dev", {
    email: "ada@example.com",
    url: `https://gatechange.dev/api/auth/magic-link/verify?token=abc123&callbackURL=${encodeURIComponent(callbackURL)}`,
  }).text;

describe("magicLinkEmail", () => {
  it("links to the confirm page, so a mail scanner's GET cannot spend the token", () => {
    const mail = magicLinkEmail("sign-in@jobs.rowlandekemezie.com", {
      email: "ada@example.com",
      url: verifyUrl,
    });

    const confirm = "https://gatechange.dev/account/confirm?token=abc123";

    expect(mail.to).toBe("ada@example.com");
    expect(mail.text).toContain(confirm);
    expect(mail.html).toContain(`href="${confirm}"`);
    expect(`${mail.text}${mail.html}`).not.toContain("/api/auth/");
  });

  it("carries a same-site return path to the confirm page and drops any other", () => {
    const authorize = "/api/auth/oauth2/authorize?client_id=c1&state=s";

    expect(linkFor(authorize)).toContain(
      `https://gatechange.dev/account/confirm?token=abc123&next=${encodeURIComponent(authorize).replaceAll("%20", "+")}`
    );

    for (const foreign of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "/\t/evil.example",
    ]) {
      expect(linkFor(foreign)).not.toContain("next=");
    }
  });
});
