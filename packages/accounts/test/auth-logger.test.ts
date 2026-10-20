import { format } from "node:util";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { createLogger } from "better-auth";
import { vi } from "vitest";

import { authLogger } from "../src/auth-logger.js";
import { SendEmailError } from "./fixtures/send-email-error.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("better-auth log privacy", () => {
  it.each([
    "recipient+signin@example.com",
    '"quoted local"@example.com',
    "δοκιμή@παράδειγμα.δοκιμή",
  ])(
    "drops %s from messages, string arguments and diagnostic fields",
    (email) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      createLogger(authLogger).error(
        `invalid recipient ${email}`,
        email,
        new SendEmailError({
          cause: {
            code: "E_VALIDATION_ERROR",
            email,
            message: `email to ${email} not allowed`,
          },
          code: email,
          message: email,
        })
      );

      const logged = errorLog.mock.calls
        .map((args) => format(...args))
        .join("\n");

      expect(logged).not.toContain(email);
      expect(logged).not.toContain("email to");
      expect(logged).toContain("SendEmailError");
      expect(logged).toContain("E_VALIDATION_ERROR");
      expect(logged).toContain("[redacted email]");
    }
  );

  it("retains diagnostic tags and codes from nested Errors without messages, stacks, private fields or cycles", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const cause = Object.assign(new Error("private cause message"), {
      code: "E_RECIPIENT_SUPPRESSED",
    });

    const error = new SendEmailError({
      cause,
      message: "private outer message",
      recipient: "recipient@example.com",
    });

    cause.cause = error;

    createLogger(authLogger).error("magic link send failed", error);

    const logged = errorLog.mock.calls
      .map((args) => format(...args))
      .join("\n");

    expect(logged).toContain("magic link send failed");
    expect(logged).toContain("SendEmailError");
    expect(logged).toContain("E_RECIPIENT_SUPPRESSED");
    expect(logged).not.toContain("private");
    expect(logged).not.toContain("recipient@example.com");
    expect(logged).not.toContain("auth-logger.test.ts");
    expect(error.cause).toBe(cause);
    expect(cause.cause).toBe(error);
  });

  it("handles the non-string first argument used by upstream error paths", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const error = Object.assign(new Error("recipient@example.com"), {
      code: "E_DELIVERY_FAILED",
    });

    // @ts-expect-error -- Upstream's session routes pass an Error as the first argument despite the logger's string declaration.
    createLogger(authLogger).error(error);

    const logged = errorLog.mock.calls
      .map((args) => format(...args))
      .join("\n");

    expect(logged).toContain("E_DELIVERY_FAILED");
    expect(logged).not.toContain("recipient@example.com");
  });

  it("preserves warning severity and the default log threshold", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger(authLogger);

    logger.info("hidden at the default threshold");
    logger.warn("authentication warning", { code: "WARNING_CODE" });

    expect(errorLog).not.toHaveBeenCalled();
    expect(infoLog).not.toHaveBeenCalled();
    expect(warningLog).toHaveBeenCalledOnce();
    expect(format(...(warningLog.mock.calls[0] ?? []))).toContain(
      "WARNING_CODE"
    );
  });
});
