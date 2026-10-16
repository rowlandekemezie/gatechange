import { describe, expect, it } from "@effect/vitest";
import { Array, Effect, Layer, Option, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import { FeedUnavailable, PostingFeeds, runIngest } from "../src/index.js";
import type { FeedRef, Posting } from "../src/index.js";
import { makeMemoryJobStore } from "./memory-job-store.js";

const feedKeys = ["greenhouse:acme", "lever:globex", "remoteok"] as const;

const catalog: ReadonlyArray<FeedRef> = Array.map(feedKeys, (key) => ({
  company: Option.some("Acme"),
  key,
  minIntervalMinutes: 1,
  source: "Greenhouse",
}));

const onlyFeed: FeedRef = {
  company: Option.some("Acme"),
  key: "greenhouse:acme",
  minIntervalMinutes: 1,
  source: "Greenhouse",
};

const FeedResponse = Schema.Union([
  Schema.TaggedStruct("Down", {}),
  Schema.TaggedStruct("Listed", {
    ids: Schema.Array(Schema.Literals(["a", "b", "c", "d", "e", "f"])),
  }),
]);

const Run = Schema.Tuple([FeedResponse, FeedResponse, FeedResponse]);

const runs = Arbitrary.array(Arbitrary.schema(Run), { maxLength: 12, minLength: 1 });

const postingFor = (id: string): Posting => ({
  company: "Acme",
  externalId: id,
  location: "Remote - Canada",
  postedAt: null,
  salary: null,
  title: "Senior Engineering Manager",
  url: `https://jobs.example/${id}`,
  workplace: "Unspecified",
});

const uniqueIds = (ids: ReadonlyArray<string>) => [...new Set(ids)].toSorted();

describe("ingest", () => {
  it.effect.prop(
    "each feed holds exactly its last successful listing, and a feed that goes down keeps what it had",
    { schedule: runs },
    ({ schedule }) =>
      Effect.gen(function* replayRuns() {
        const memory = yield* makeMemoryJobStore;
        const expected = new Map<string, ReadonlyArray<string>>();

        for (const responses of schedule) {
          const feeds = PostingFeeds.of({
            catalog,
            fetch: (feed) => {
              const response = Option.flatMap(
                Array.findFirstIndex(feedKeys, (key) => key === feed.key),
                (index) => Array.get(responses, index)
              );

              return Option.match(response, {
                onNone: () => Effect.fail(new FeedUnavailable({ feed: feed.key, message: "missing" })),
                onSome: (found) =>
                  found._tag === "Listed"
                    ? Effect.succeed(Array.map(found.ids, postingFor))
                    : Effect.fail(new FeedUnavailable({ feed: feed.key, message: "down" })),
              });
            },
          });

          yield* runIngest({ feedConcurrency: 2, feedsPerRun: feedKeys.length }).pipe(
            Effect.provide(Layer.merge(memory.layer, Layer.succeed(PostingFeeds, feeds)))
          );

          for (const [index, key] of feedKeys.entries()) {
            const response = responses[index];

            if (response?._tag === "Listed") {
              expected.set(key, uniqueIds(response.ids));
            }
          }

          for (const key of feedKeys) {
            const stored = Array.filter(memory.jobs(), (job) => job.feed === key);

            expect(uniqueIds(Array.map(stored, (job) => job.id.slice(key.length + 1)))).toStrictEqual(
              expected.get(key) ?? []
            );
          }

          yield* TestClock.adjust("2 hours");
        }

        expect(memory.runs().length).toBe(schedule.length);
      })
  );

  it.effect("titles outside engineering leadership never reach the store", () =>
    Effect.gen(function* filterTitles() {
      const memory = yield* makeMemoryJobStore;
      const titles = ["Product Manager", "Staff Software Engineer", "VP of Engineering"];

      const feeds = PostingFeeds.of({
        catalog: [onlyFeed],
        fetch: () =>
          Effect.succeed(
            Array.map(titles, (title, index) => ({ ...postingFor(`t${index}`), title }))
          ),
      });

      yield* runIngest({ feedConcurrency: 1, feedsPerRun: 1 }).pipe(
        Effect.provide(Layer.merge(memory.layer, Layer.succeed(PostingFeeds, feeds)))
      );

      expect(Array.map(memory.jobs(), (job) => job.title)).toStrictEqual(["VP of Engineering"]);
    })
  );
});
