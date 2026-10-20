import { applyBillingChange } from "@rat-stack/core";
import { Clock, Effect, Option } from "effect";
import { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http";

import { verifiedChange } from "./webhook.js";
import type { StripeEndpoint } from "./webhook.js";

const reply = (status: number, body: string) =>
  HttpServerResponse.text(body, {
    headers: { "cache-control": "no-store" },
    status,
  });

export const stripeWebhookResponse = (
  endpoint: Option.Option<StripeEndpoint>,
  request: HttpServerRequest.HttpServerRequest
) =>
  Effect.gen(function* stripeWebhook() {
    if (request.method !== "POST") {
      return reply(405, "method not allowed");
    }

    if (Option.isNone(endpoint)) {
      return reply(503, "billing is off");
    }

    const payload = yield* request.text.pipe(Effect.orElseSucceed(() => ""));

    const header = request.headers["stripe-signature"] ?? "";
    const now = yield* Clock.currentTimeMillis;

    return yield* verifiedChange(endpoint.value, payload, header, now).pipe(
      Effect.flatMap(applyBillingChange),
      Effect.map((outcome) =>
        reply(outcome === "Unmatched" ? 409 : 200, outcome)
      ),
      Effect.catchTags({
        JobStoreUnavailable: (failure) =>
          Effect.logWarning("billing webhook store failure", failure).pipe(
            Effect.as(reply(500, "store unavailable"))
          ),
        WebhookRejected: ({ reason }) =>
          Effect.logWarning("billing webhook rejected", { reason }).pipe(
            Effect.as(
              reply(
                400,
                reason === "BadSignature" ? "invalid signature" : "malformed"
              )
            )
          ),
      })
    );
  });
