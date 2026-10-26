import { describe, expect, it } from "@effect/vitest";
import { listingsFromPostings } from "@rat-stack/core";
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
          new Response(body, {
            headers: { "content-type": "application/json" },
            status,
          })
        )
      )
    )
  );

describe("company boards", () => {
  it.effect(
    "a Greenhouse board keeps every well-formed job and skips a malformed one",
    () =>
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
                  first_published: "2025-10-09T08:53:20.000Z",
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

  it.effect.each([
    { expected: null, first_published: undefined },
    { expected: null, first_published: null },
    { expected: null, first_published: "" },
    { expected: null, first_published: "not a date" },
    {
      expected: 1_760_000_000_000,
      first_published: "2025-10-09T08:53:20.000Z",
    },
  ])(
    "Greenhouse publication dates preserve missing and unreadable facts %#",
    ({ first_published, expected }) =>
      Effect.gen(function* publicationDate() {
        const [posting] = yield* greenhousePostings("greenhouse:acme", "acme");

        expect(posting?.postedAt).toBe(expected);
      }).pipe(
        Effect.provide(
          respondWith(
            JSON.stringify({
              jobs: [
                {
                  absolute_url: "https://boards.greenhouse.io/acme/jobs/42",
                  first_published,
                  id: 42,
                  title: "Engineering Manager",
                  updated_at: "2026-10-09T08:53:20.000Z",
                },
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
              categories: {
                allLocations: ["Vancouver, BC", "Toronto, ON"],
                location: "Vancouver, BC",
              },
              createdAt: 1_760_000_000_000,
              hostedUrl: "https://jobs.lever.co/acme/1",
              id: "1",
              salaryRange: {
                currency: "CAD",
                interval: "per-year-salary",
                max: 220_000,
                min: 180_000,
              },
              text: "Director of Engineering",
              workplaceType: "remote",
            },
          ])
        )
      )
    )
  );

  it.effect.each([
    { country: "IN", location: "Chennai", region: "Elsewhere" },
    { country: "IN", location: "Hyderabad", region: "Elsewhere" },
    { country: "US", location: "Boise", region: "RemoteUnitedStates" },
    { country: "CA", location: "Whitehorse", region: "RemoteCanada" },
    { country: "AU", location: "Victoria", region: "Elsewhere" },
    { country: "US", location: "Victoria", region: "RemoteUnitedStates" },
    { country: "IN", location: "Worldwide", region: "RemoteGlobal" },
    { country: "IN", location: "North America", region: "RemoteNorthAmerica" },
    { country: "US", location: "US and Canada", region: "RemoteNorthAmerica" },
    { country: "IN", location: "Canada and India", region: "RemoteCanada" },
    { country: undefined, location: "Undisclosed", region: "RemoteGlobal" },
    { country: null, location: "Undisclosed", region: "RemoteGlobal" },
  ])(
    "Lever country $country classifies $location without rewriting it",
    ({ country, location, region }) =>
      Effect.gen(function* classifyLeverCountry() {
        const postings = yield* leverPostings("lever:acme", "acme");

        const { jobs } = listingsFromPostings(
          {
            company: Option.some("Acme"),
            key: "lever:acme",
            minIntervalMinutes: 180,
            source: "Lever",
          },
          postings,
          1_760_000_000_000
        );

        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.location).toBe(location);
        expect(jobs[0]?.region).toBe(region);
      }).pipe(
        Effect.provide(
          respondWith(
            JSON.stringify([
              {
                categories: { allLocations: [location], location },
                country,
                hostedUrl: "https://jobs.lever.co/acme/1",
                id: "1",
                text: "Director of Engineering",
                workplaceType: "remote",
              },
            ])
          )
        )
      )
  );

  it.effect.each(["", "USA", "in", 42, { country: "IN" }])(
    "ignores malformed country evidence %j without dropping a valid listing",
    (country) =>
      Effect.gen(function* invalidCountry() {
        const postings = yield* leverPostings("lever:acme", "acme");

        expect(postings).toHaveLength(1);
        expect(postings[0]).not.toHaveProperty("country");
      }).pipe(
        Effect.provide(
          respondWith(
            JSON.stringify([
              {
                country,
                hostedUrl: "https://jobs.lever.co/acme/1",
                id: "1",
                text: "Director of Engineering",
                workplaceType: "remote",
              },
            ])
          )
        )
      )
  );

  it.effect("does not narrow secondary locations to the primary country", () =>
    Effect.gen(function* severalCountries() {
      const postings = yield* leverPostings("lever:acme", "acme");

      expect(postings[0]).not.toHaveProperty("country");
      expect(postings[0]?.location).toBe("Chennai; Whitehorse");
      expect(
        listingsFromPostings(
          {
            company: Option.some("Acme"),
            key: "lever:acme",
            minIntervalMinutes: 180,
            source: "Lever",
          },
          postings,
          1_760_000_000_000
        ).jobs[0]?.region
      ).toBe("RemoteCanada");
    }).pipe(
      Effect.provide(
        respondWith(
          JSON.stringify([
            {
              categories: {
                allLocations: ["Chennai", "Whitehorse"],
                location: "Chennai",
              },
              country: "IN",
              hostedUrl: "https://jobs.lever.co/acme/1",
              id: "1",
              text: "Director of Engineering",
              workplaceType: "remote",
            },
          ])
        )
      )
    )
  );

  it.effect(
    "a board that answers with an error status is reported as unavailable",
    () =>
      Effect.gen(function* readMissingBoard() {
        const failure = yield* Effect.flip(
          greenhousePostings("greenhouse:missing", "missing")
        );

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
    expect(
      postingOfComment("Acme | Senior Backend Engineer | Remote", "1", 1)
    ).toStrictEqual(Option.none());
  });
});

describe("value parsing", () => {
  it.prop(
    "seconds and milliseconds since the epoch read as the same instant",
    {
      seconds: Schema.Int.check(
        Schema.isBetween({ maximum: 4_000_000_000, minimum: 1_000_000_000 })
      ),
    },
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
