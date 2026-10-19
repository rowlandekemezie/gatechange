import { describe, expect, it } from "@effect/vitest";

import { magicLinkEmail } from "../src/index.js";

const verifyUrl =
  "https://jobs.rowlandekemezie.com/api/auth/magic-link/verify?token=abc123&callbackURL=%2Faccount";

describe("magicLinkEmail", () => {
  it("links to the confirm page, so a mail scanner's GET cannot spend the token", () => {
    const mail = magicLinkEmail("sign-in@jobs.rowlandekemezie.com", {
      email: "ada@example.com",
      url: verifyUrl,
    });

    const confirm =
      "https://jobs.rowlandekemezie.com/account/confirm?token=abc123";

    expect(mail.to).toBe("ada@example.com");
    expect(mail.text).toContain(confirm);
    expect(mail.html).toContain(`href="${confirm}"`);
    expect(`${mail.text}${mail.html}`).not.toContain("/api/auth/");
  });
});
