import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";

import { FetchJobs } from "../src/client/board/command.js";
import { defaultFilters, queryOf } from "../src/client/board/filters.js";
import { Message } from "../src/client/board/message.js";
import { JobQueries } from "../src/client/board/queries.js";

const fetchJobsAnswering = (status: number) =>
  Effect.gen(function* fetchJobs() {
    const message = yield* FetchJobs({
      generation: 0,
      query: queryOf(defaultFilters, 0),
    }).effect.pipe(Effect.provide(JobQueries.layer), Effect.scoped);

    return message;
  }).pipe(
    Effect.provideService(
      FetchHttpClient.Fetch,
      // @effect-diagnostics-next-line asyncFunction:off -- Fakes the Promise-returning fetch.
      async () => await Promise.resolve(new Response("{}", { status }))
    )
  );

beforeEach(() => {
  vi.stubGlobal("location", {
    origin: "https://jobs.example",
    pathname: "/",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a rate-limited job list", () => {
  it.effect("tells the visitor to wait, not to check their connection", () =>
    Effect.gen(function* limited() {
      const message = yield* fetchJobsAnswering(429);

      expect(message).toStrictEqual(
        Message.FailedFetchJobs({
          generation: 0,
          message:
            "Too many requests from your network. Wait a minute, then try again.",
        })
      );
    })
  );

  it.effect("keeps the connection advice for other failures", () =>
    Effect.gen(function* unreachable() {
      const message = yield* fetchJobsAnswering(502);

      expect(message).toStrictEqual(
        Message.FailedFetchJobs({
          generation: 0,
          message:
            "Could not reach the job list. Check your connection, then try again.",
        })
      );
    })
  );
});
