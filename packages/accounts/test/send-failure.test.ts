import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Logger, References } from "effect";

import { logSendFailure, magicLinkEmail } from "../src/index.js";
import type { MagicLinkEmail, MagicLinkRequest } from "../src/index.js";

class SendEmailError extends Data.TaggedError("SendEmailError")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

const TOKEN = "tok-9f3a1c7e";

const REQUEST: MagicLinkRequest = {
  email: "ada.lovelace@example.com",
  url: `https://jobs.example/api/auth/magic-link/verify?token=${TOKEN}`,
};

const refusedBySender = (_mail: MagicLinkEmail) =>
  Effect.fail(
    new SendEmailError({
      cause: Object.assign(
        new Error(`invalid recipient address ${REQUEST.email}`),
        { code: "E_VALIDATION_ERROR" }
      ),
      message: "send_email failed",
    })
  );

describe("logSendFailure", () => {
  it.effect(
    "logs Cloudflare's error code without its message, the recipient or the token",
    () =>
      Effect.gen(function* logsCode() {
        const entries: unknown[] = [];

        yield* refusedBySender(
          magicLinkEmail("sign-in@jobs.example", REQUEST)
        ).pipe(
          Effect.tapError(logSendFailure),
          Effect.ignore,
          Effect.provide(
            Logger.layer([
              Logger.make(({ fiber, message }) =>
                entries.push({
                  fields: fiber.getRef(References.CurrentLogAnnotations),
                  message,
                })
              ),
            ])
          )
        );

        const logged = JSON.stringify(entries);

        expect(logged).toContain("E_VALIDATION_ERROR");
        expect(entries).toStrictEqual([
          {
            fields: {
              causeCode: "E_VALIDATION_ERROR",
              errorTag: "SendEmailError",
            },
            message: ["magic link send failed"],
          },
        ]);
        expect(logged).not.toContain("causeMessage");
        expect(logged).not.toContain(REQUEST.email);
        expect(logged).not.toContain(TOKEN);
        expect(logged).not.toContain("magic-link/verify");
      })
  );
});
