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
      cause: Object.assign(new Error("sender domain not available"), {
        code: "E_SENDER_DOMAIN_NOT_AVAILABLE",
      }),
      message: "send_email failed",
    })
  );

describe("logSendFailure", () => {
  it.effect(
    "logs Cloudflare's error code and message without the recipient or token",
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

        expect(logged).toContain("E_SENDER_DOMAIN_NOT_AVAILABLE");
        expect(entries).toStrictEqual([
          {
            fields: {
              causeCode: "E_SENDER_DOMAIN_NOT_AVAILABLE",
              causeMessage: "sender domain not available",
              errorTag: "SendEmailError",
            },
            message: ["magic link send failed"],
          },
        ]);
        expect(logged).not.toContain(REQUEST.email);
        expect(logged).not.toContain(TOKEN);
        expect(logged).not.toContain("magic-link/verify");
      })
  );
});
