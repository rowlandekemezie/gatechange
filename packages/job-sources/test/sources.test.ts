import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  epochMillisOf,
  greenhousePostings,
  leverPostings,
  postingOfComment,
  salaryRange,
} from "../src/index.js";

const respondWith = (body: string, status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, { headers: { "content-type": "application/json" }, status })
        )
      )
    )
  );

describe("company boards", () => {
  it.effect("a Greenhouse board keeps every well-formed job and skips a malformed one", () =>
    Effect.gen(function* readGreenhouse() {
      const postings = yield* greenhousePostings("greenhouse:acme", "acme");

      expect(postings).toStrictEqual([
        {
          company: "",
          externalId: "42",
          location: "Remote - Canada",
          postedAt: 1_760_000_000_000,
          salary: null,
          title: "Engineering Manager, Payments",
          url: "https://boards.greenhouse.io/acme/jobs/42",
          workplace: "Unspecified",
        },
      ]);
    }).pipe(
      Effect.provide(
        respondWith(
          JSON.stringify({
            jobs: [
              {
                absolute_url: "https://boards.greenhouse.io/acme/jobs/42",
                id: 42,
                location: { name: "Remote - Canada" },
                title: "Engineering Manager, Payments",
                updated_at: "2025-10-09T08:53:20.000Z",
              },
              { id: 43, title: "Missing a URL" },
            ],
          })
        )
      )
    )
  );

  it.effect("a Lever board reports its workplace flag and salary range", () =>
    Effect.gen(function* readLever() {
      const [posting] = yield* leverPostings("lever:acme", "acme");

      expect(posting?.workplace).toBe("Remote");
      expect(posting?.salary).toBe("180k–220k CAD / year");
      expect(posting?.location).toBe("Vancouver, BC; Toronto, ON");
    }).pipe(
      Effect.provide(
        respondWith(
          JSON.stringify([
            {
              categories: { allLocations: ["Vancouver, BC", "Toronto, ON"], location: "Vancouver, BC" },
              createdAt: 1_760_000_000_000,
              hostedUrl: "https://jobs.lever.co/acme/1",
              id: "1",
              salaryRange: { currency: "CAD", interval: "per-year-salary", max: 220_000, min: 180_000 },
              text: "Director of Engineering",
              workplaceType: "remote",
            },
          ])
        )
      )
    )
  );

  it.effect("a board that answers with an error status is reported as unavailable", () =>
    Effect.gen(function* readMissingBoard() {
      const failure = yield* Effect.flip(greenhousePostings("greenhouse:missing", "missing"));

      expect(failure._tag).toBe("FeedUnavailable");
      expect(failure.feed).toBe("greenhouse:missing");
    }).pipe(Effect.provide(respondWith("{}", 404)))
  );
});

describe("Hacker News comments", () => {
  it("reads company, role, location and pay from the first line", () => {
    expect(
      postingOfComment(
        "Acme Corp | Engineering Manager, Platform | Remote (US &amp; Canada) | $190k-$230k<p>We build things.",
        "123",
        1_760_000_000
      )
    ).toStrictEqual(
      Option.some({
        company: "Acme Corp",
        externalId: "123",
        location: "Remote (US & Canada)",
        postedAt: 1_760_000_000_000,
        salary: "$190k-$230k",
        title: "Engineering Manager, Platform",
        url: "https://news.ycombinator.com/item?id=123",
        workplace: "Unspecified",
      })
    );
  });

  it("ignores a post with no engineering leadership role in its first line", () => {
    expect(postingOfComment("Acme | Senior Backend Engineer | Remote", "1", 1)).toStrictEqual(
      Option.none()
    );
  });
});

describe("value parsing", () => {
  it.prop(
    "seconds and milliseconds since the epoch read as the same instant",
    { seconds: Schema.Int.check(Schema.isBetween({ maximum: 4_000_000_000, minimum: 1_000_000_000 })) },
    ({ seconds }) => {
      expect(epochMillisOf(seconds)).toBe(epochMillisOf(seconds * 1000));
    }
  );

  it("an unreadable date is absent rather than a guess", () => {
    expect(epochMillisOf("not a date")).toBeNull();
    expect(epochMillisOf(null)).toBeNull();
  });

  it("a salary with only one bound still shows that bound", () => {
    expect(salaryRange(null, 150_000, "usd", null)).toBe("150k USD");
    expect(salaryRange(null, null, "usd", "year")).toBeNull();
  });
});
