import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  guardPreviewAccess,
  PREVIEW_SECRET_HEADER,
} from "../src/preview-access.js";

const secret = "a-preview-secret-with-at-least-32-characters";

const publicOrigin = "https://pr-7-jobs-preview.rowland-ekemezie.workers.dev";

const handle = Effect.gen(function* inspectRequest() {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const web = yield* HttpServerRequest.toWeb(request);

  return HttpServerResponse.jsonUnsafe({
    cookie: web.headers.get("cookie"),
    host: web.headers.get("host"),
    origin: web.headers.get("origin"),
    secret: web.headers.get(PREVIEW_SECRET_HEADER),
    url: web.url,
  });
});

const send = (headers: Record<string, string>, configuredSecret = secret) =>
  guardPreviewAccess({
    handle,
    publicOrigin,
    secret: Redacted.make(configuredSecret),
    stage: "pr-7",
  }).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request(
          "https://backend.workers.dev/api/auth/magic-link/verify?token=abc",
          { headers }
        )
      )
    )
  );

describe("native preview backend access", () => {
  it.effect(
    "rejects missing, wrong, and empty transport credentials before routing",
    () =>
      Effect.gen(function* rejected() {
        for (const headers of [{}, { [PREVIEW_SECRET_HEADER]: "wrong" }]) {
          expect((yield* send(headers)).status).toBe(403);
        }

        expect((yield* send({ [PREVIEW_SECRET_HEADER]: "" }, "")).status).toBe(
          403
        );
      })
  );

  it.effect(
    "normalizes the actual auth Request to the exact public origin",
    () =>
      Effect.gen(function* accepted() {
        const response = yield* send({
          cookie: "session=abc",
          host: "attacker.example",
          origin: publicOrigin,
          [PREVIEW_SECRET_HEADER]: secret,
          "x-forwarded-host": "attacker.example",
        });

        const web = HttpServerResponse.toWeb(response);
        const body = yield* Effect.promise(web.json.bind(web));

        expect(web.headers.get("x-jobs-preview-stage")).toBe("pr-7");
        expect(body).toStrictEqual({
          cookie: "session=abc",
          host: new URL(publicOrigin).host,
          origin: publicOrigin,
          secret: null,
          url: `${publicOrigin}/api/auth/magic-link/verify?token=abc`,
        });
      })
  );
});
