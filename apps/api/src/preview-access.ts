import { Effect, Redacted } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

export const PREVIEW_SECRET_HEADER = "x-jobs-preview-secret";

export const guardPreviewAccess = <Error, Context>({
  handle,
  publicOrigin,
  secret,
  stage,
}: {
  readonly handle: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    Error,
    Context
  >;
  readonly publicOrigin: string;
  readonly secret: Redacted.Redacted;
  readonly stage: string;
}) =>
  Effect.gen(function* previewAccess() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const expected = Redacted.value(secret);

    if (
      expected.length < 32 ||
      request.headers[PREVIEW_SECRET_HEADER] !== expected
    ) {
      return HttpServerResponse.empty({
        headers: { "cache-control": "private, no-store" },
        status: 403,
      });
    }

    const incoming = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
    const original = new URL(incoming.url);
    const destination = new URL(publicOrigin);
    destination.pathname = original.pathname;
    destination.search = original.search;
    const headers = new Headers(incoming.headers);
    headers.delete(PREVIEW_SECRET_HEADER);
    headers.delete("x-forwarded-host");
    headers.delete("x-forwarded-proto");
    headers.set("host", destination.host);

    const forwarded = new Request(new Request(destination, incoming), {
      headers,
    });

    return yield* handle.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(forwarded)
      ),
      Effect.map(HttpServerResponse.setHeader("x-jobs-preview-stage", stage))
    );
  });
