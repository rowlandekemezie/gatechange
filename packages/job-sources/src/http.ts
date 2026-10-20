import { FeedUnavailable } from "@rat-stack/core";
import { Effect, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

export const USER_AGENT =
  "jobs.rowlandekemezie.com/1.0 (engineering leadership job board; +https://jobs.rowlandekemezie.com)";

export const REQUEST_TIMEOUT = "20 seconds";

export const TRANSIENT_RETRIES = 2;

export const getJson = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  url: string,
  envelope: S
) =>
  Effect.gen(function* readJson() {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({
        schedule: Schedule.exponential("500 millis"),
        times: TRANSIENT_RETRIES,
      })
    );

    const response = yield* client.execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/json",
          "user-agent": USER_AGENT,
        })
      )
    );

    const body = yield* response.json;

    return yield* Schema.decodeUnknownEffect(envelope)(body);
  }).pipe(Effect.timeout(REQUEST_TIMEOUT));

export const fetchJson = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  feed: string,
  url: string,
  envelope: S
) =>
  getJson(url, envelope).pipe(
    Effect.mapError(
      (failure) =>
        new FeedUnavailable({
          feed,
          message: failure.message.slice(0, 500),
        })
    )
  );
