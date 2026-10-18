import { describe, expect, it } from "@effect/vitest";
import { amountsIn, PostingTexts, PostingUnavailable } from "@rat-stack/core";
import type { JobValue } from "@rat-stack/core";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { postingTextsLayer } from "../src/index.js";
import ashbyFixture from "./fixtures/ashby-board.json" with { type: "json" };
import greenhouseFixture from "./fixtures/greenhouse-job.json" with { type: "json" };
import leverFixture from "./fixtures/lever-posting.json" with { type: "json" };
import smartRecruitersFixture from "./fixtures/smartrecruiters-posting.json" with { type: "json" };
import workableFixture from "./fixtures/workable-job.json" with { type: "json" };

const greenhouseJob = JSON.stringify(greenhouseFixture);

const leverPosting = JSON.stringify(leverFixture);

const ashbyBoard = JSON.stringify(ashbyFixture);

const smartRecruitersPosting = JSON.stringify(smartRecruitersFixture);

const workableJob = JSON.stringify(workableFixture);

const serving = (body: string, status = 200) => {
  const requested: string[] = [];

  const client = HttpClient.make((request) => {
    requested.push(request.url);

    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          headers: { "content-type": "application/json" },
          status,
        })
      )
    );
  });

  return {
    layer: postingTextsLayer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
    ),
    requested,
  };
};

const jobWithId = (id: string): JobValue => ({
  arrangement: "Remote",
  company: "Acme",
  feed: id.split(":").slice(0, 2).join(":"),
  firstSeenAt: 1_760_000_000_000,
  id,
  lastSeenAt: 1_760_000_000_000,
  location: "Remote",
  postedAt: 1_760_000_000_000,
  region: "RemoteGlobal",
  relevance: 1,
  role: "EngineeringManager",
  salary: null,
  source: "Greenhouse",
  title: "Engineering Manager",
  url: "https://example.com/job",
});

const fetchText = Effect.fnUntraced(function* fetchText(id: string) {
  const texts = yield* PostingTexts;

  return yield* texts.fetch(jobWithId(id));
});

describe("posting texts", () => {
  it.effect(
    "a Greenhouse posting decodes its escaped HTML into plain text",
    () => {
      const server = serving(greenhouseJob);

      return Effect.gen(function* readGreenhouse() {
        const text = yield* fetchText("greenhouse:vercel:6136160004");

        expect(server.requested).toStrictEqual([
          "https://boards-api.greenhouse.io/v1/boards/vercel/jobs/6136160004",
        ]);
        expect(text.startsWith("About Vercel: Vercel is the agentic")).toBe(
          true
        );
        expect(text).toContain("we've helped builders");
        expect(text).not.toMatch(/[<>]|&[a-z#0-9]+;/u);
      }).pipe(Effect.provide(server.layer));
    }
  );

  it.effect(
    "a Lever posting joins its description, lists, additional text and salary",
    () => {
      const server = serving(leverPosting);

      return Effect.gen(function* readLever() {
        const text = yield* fetchText(
          "lever:outreach:5becd4e1-3474-4f36-b5dd-4b2cd0eb1179"
        );

        expect(server.requested).toStrictEqual([
          "https://api.lever.co/v0/postings/outreach/5becd4e1-3474-4f36-b5dd-4b2cd0eb1179",
        ]);
        expect(text.startsWith("About Outreach")).toBe(true);
        expect(text).toContain("Your Daily Adventures Will Include:");
        expect(text).toContain(
          "Run Daily Advocacy Operations: Own the day-to-day operations"
        );
        expect(text).toContain("Why You’ll Love It Here");
        expect(text).toContain("$70,000-$110,000 USD");
        expect(text).not.toContain("<li>");
        expect(amountsIn(text).has(70_000)).toBe(true);
        expect(amountsIn(text).has(110_000)).toBe(true);
      }).pipe(Effect.provide(server.layer));
    }
  );

  it.effect(
    "an Ashby posting is picked from its board with the compensation summary",
    () => {
      const server = serving(ashbyBoard);

      return Effect.gen(function* readAshby() {
        const text = yield* fetchText(
          "ashby:clickup:abcd8589-5341-4890-99bb-3dcfc93246a9"
        );

        expect(server.requested).toStrictEqual([
          "https://api.ashbyhq.com/posting-api/job-board/clickup?includeCompensation=true",
        ]);
        expect(text.startsWith("At ClickUp, we're building")).toBe(true);
        expect(text).toContain("Come join the Hierarchy Squad");
        expect(text).toContain("please contact us at AskPeople@ClickUp.com.");
        expect(
          text.endsWith("Compensation: $200K – $250K USD per 1 YEAR")
        ).toBe(true);
        expect(amountsIn(text).has(200_000)).toBe(true);
      }).pipe(Effect.provide(server.layer));
    }
  );

  it.effect(
    "a SmartRecruiters posting joins its job ad sections as plain text",
    () => {
      const server = serving(smartRecruitersPosting);

      return Effect.gen(function* readSmartRecruiters() {
        const text = yield* fetchText(
          "smartrecruiters:ServiceNow:744000156092859"
        );

        expect(server.requested).toStrictEqual([
          "https://api.smartrecruiters.com/v1/companies/ServiceNow/postings/744000156092859",
        ]);
        expect(text.startsWith("Company Description")).toBe(true);
        expect(text).toContain("Sr Software Engineering Manager");
        expect(text).toContain("Qualifications");
        expect(text).not.toMatch(/[<>]|&[a-z#0-9]+;/u);
        expect(amountsIn(text).has(190_900)).toBe(true);
        expect(amountsIn(text).has(334_100)).toBe(true);
      }).pipe(Effect.provide(server.layer));
    }
  );

  it.effect(
    "a Workable job joins its description, requirements and benefits",
    () => {
      const server = serving(workableJob);

      return Effect.gen(function* readWorkable() {
        const text = yield* fetchText("workable:huggingface:81B46579FE");

        expect(server.requested).toStrictEqual([
          "https://apply.workable.com/api/v2/accounts/huggingface/jobs/81B46579FE",
        ]);
        expect(text.startsWith("At Hugging Face, we're on a journey")).toBe(
          true
        );
        expect(text).toContain("Please provide a cover letter");
        expect(text).not.toMatch(/[<>]|&[a-z#0-9]+;/u);
      }).pipe(Effect.provide(server.layer));
    }
  );

  it.effect("an Ashby posting missing from its board is unavailable", () =>
    Effect.gen(function* readMissingAshby() {
      const failure = yield* Effect.flip(fetchText("ashby:clickup:gone"));

      expect(failure).toStrictEqual(
        new PostingUnavailable({
          id: "ashby:clickup:gone",
          message: "the posting is no longer on the Ashby board",
        })
      );
    }).pipe(Effect.provide(serving(ashbyBoard).layer))
  );

  it.effect("a board that answers with an error status is unavailable", () =>
    Effect.gen(function* readMissingPosting() {
      const failure = yield* Effect.flip(fetchText("greenhouse:vercel:1"));

      expect(failure._tag).toBe("PostingUnavailable");
      expect(failure.id).toBe("greenhouse:vercel:1");
    }).pipe(Effect.provide(serving("{}", 404).layer))
  );

  it.effect("a payload missing the posting text is unavailable", () =>
    Effect.gen(function* readEmptyPosting() {
      const failure = yield* Effect.flip(fetchText("greenhouse:vercel:1"));

      expect(failure._tag).toBe("PostingUnavailable");
    }).pipe(Effect.provide(serving(JSON.stringify({ id: 1 })).layer))
  );

  it.effect(
    "a posting with empty content is read as empty text for core to skip, not as unavailable",
    () =>
      Effect.gen(function* readBlankPosting() {
        const text = yield* fetchText("greenhouse:vercel:1");

        expect(text).toBe("");
      }).pipe(Effect.provide(serving(JSON.stringify({ content: "" })).layer))
  );

  it.effect(
    "an aggregator id or an unparseable id is unavailable without a request",
    () => {
      const server = serving(greenhouseJob);

      return Effect.gen(function* readUnsupported() {
        const aggregator = yield* Effect.flip(fetchText("remoteok:all:123"));
        const nonsense = yield* Effect.flip(fetchText("greenhouse-only"));

        expect(aggregator._tag).toBe("PostingUnavailable");
        expect(nonsense._tag).toBe("PostingUnavailable");
        expect(server.requested).toStrictEqual([]);
      }).pipe(Effect.provide(server.layer));
    }
  );
});
