import { describe, expect, it } from "@effect/vitest";
import {
  Array,
  Clock,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  pipe,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import {
  DAY_MILLIS,
  FeedUnavailable,
  JobStore,
  PostingFeeds,
  runIngest,
} from "../src/index.js";
import type { FeedRef, JobQueryValue, PostingValue } from "../src/index.js";
import { makeMemoryJobStore } from "./memory-job-store.js";
import type { MemoryJobStore } from "./memory-job-store.js";

const feedKeys = ["greenhouse:acme", "lever:globex", "remoteok"] as const;

const catalog: readonly FeedRef[] = pipe(
  feedKeys,
  Array.map((key) => ({
    company: Option.some("Acme"),
    key,
    minIntervalMinutes: 1,
    source: "Greenhouse",
  }))
);

const onlyFeed: FeedRef = {
  company: Option.some("Acme"),
  key: "greenhouse:acme",
  minIntervalMinutes: 1,
  source: "Greenhouse",
};

const Down = Schema.TaggedStruct("Down", {});

const Listed = Schema.TaggedStruct("Listed", {
  ids: Schema.Array(Schema.Literals(["a", "b", "c", "d", "e", "f"])),
});

const FeedResponse = Schema.Union([Down, Listed]);

const Run = Schema.Tuple([FeedResponse, FeedResponse, FeedResponse]);

const runs = Arbitrary.array(Arbitrary.schema(Run), {
  maxLength: 12,
  minLength: 1,
});

const postingFor = (id: string): PostingValue => ({
  company: "Acme",
  externalId: id,
  location: "Remote - Canada",
  postedAt: null,
  salary: null,
  title: `Senior Engineering Manager, Team ${id}`,
  url: `https://jobs.example/${id}`,
  workplace: "Unspecified",
});

const ingestResponses = (
  memory: MemoryJobStore,
  responses: typeof Run.Type
) => {
  const feeds = PostingFeeds.of({
    catalog,
    fetch: (feed) => {
      const response = pipe(
        Array.findFirstIndex(feedKeys, (key) => key === feed.key),
        Option.flatMap((index) => Array.get(responses, index))
      );

      return Option.match(response, {
        onNone: () =>
          Effect.fail(
            new FeedUnavailable({ feed: feed.key, message: "missing" })
          ),
        onSome: (found) =>
          Predicate.isTagged(found, "Listed")
            ? Effect.succeed(pipe(found.ids, Array.map(postingFor)))
            : Effect.fail(
                new FeedUnavailable({ feed: feed.key, message: "down" })
              ),
      });
    },
  });

  return runIngest({
    feedConcurrency: 2,
    feedsPerRun: feedKeys.length,
  }).pipe(
    Effect.provide(
      Layer.merge(memory.layer, Layer.succeed(PostingFeeds, feeds))
    )
  );
};

const listed = (ids: (typeof Listed.Type)["ids"]) => Listed.make({ ids });

const down = Down.make({});

const listAll: JobQueryValue = {
  limit: 100,
  maxAgeDays: 30,
  offset: 0,
  regions: [],
  roles: [],
  search: "",
  sort: "Newest",
};

const uniqueIds = (ids: readonly string[]) => [...new Set(ids)].toSorted();

describe("ingest", () => {
  it.effect.prop(
    "each feed holds exactly its last successful listing, and a feed that goes down keeps what it had",
    { schedule: runs },
    ({ schedule }) =>
      Effect.gen(function* replayRuns() {
        const memory = yield* makeMemoryJobStore;
        const expected = new Map<string, readonly string[]>();

        for (const responses of schedule) {
          yield* ingestResponses(memory, responses);

          for (const [index, key] of feedKeys.entries()) {
            const response = responses[index];

            if (
              response !== undefined &&
              Predicate.isTagged(response, "Listed")
            ) {
              expected.set(key, uniqueIds(response.ids));
            }
          }

          for (const key of feedKeys) {
            const stored = pipe(
              memory.jobs(),
              Array.filter((job) => job.feed === key)
            );

            expect(
              uniqueIds(
                pipe(
                  stored,
                  Array.map((job) => job.id.slice(key.length + 1))
                )
              )
            ).toStrictEqual(expected.get(key) ?? []);
          }

          yield* TestClock.adjust("2 hours");
        }

        expect(memory.runs().length).toBe(schedule.length);
      })
  );

  it.effect.prop(
    "history first-seen never moves later, sightings and repost counts only grow, and no history is lost",
    { schedule: runs },
    ({ schedule }) =>
      Effect.gen(function* replayHistory() {
        const memory = yield* makeMemoryJobStore;
        let before = new Map(memory.history());

        for (const responses of schedule) {
          yield* ingestResponses(memory, responses);
          yield* TestClock.adjust("1 day");

          const after = new Map(memory.history());

          for (const [fingerprint, previous] of before) {
            const next = after.get(fingerprint);

            expect(next).toBeDefined();
            expect(next?.firstSeenAt).toBeLessThanOrEqual(previous.firstSeenAt);
            expect(next?.sightings).toBeGreaterThanOrEqual(previous.sightings);
            expect(next?.reposts).toBeGreaterThanOrEqual(previous.reposts);
          }

          before = after;
        }
      })
  );

  it.effect(
    "a role that disappears and comes back keeps its first-seen date and counts one repost",
    () =>
      Effect.gen(function* repost() {
        const memory = yield* makeMemoryJobStore;
        const firstSeenAt = yield* Clock.currentTimeMillis;

        yield* ingestResponses(memory, [listed(["a"]), down, down]);
        yield* TestClock.adjust("2 days");
        yield* ingestResponses(memory, [listed([]), listed([]), listed([])]);
        yield* TestClock.adjust("2 days");
        yield* ingestResponses(memory, [listed(["a"]), down, down]);
        yield* TestClock.adjust("1 day");

        const now = yield* Clock.currentTimeMillis;

        const { history, page } = yield* Effect.gen(function* readHistory() {
          const store = yield* JobStore;

          return {
            history: yield* store.historyOf(postingFor("a")),
            page: yield* store.list(listAll, now),
          };
        }).pipe(Effect.provide(memory.layer));

        expect(history).toStrictEqual(
          Option.some({
            firstSeenAt,
            lastSeenAt: firstSeenAt + 4 * DAY_MILLIS,
            reposts: 1,
            sightings: 2,
          })
        );
        expect(
          pipe(
            page.jobs,
            Array.map((job) => [job.daysOpen, job.reposts])
          )
        ).toStrictEqual([[5, 1]]);
      })
  );

  it.effect("titles outside engineering leadership never reach the store", () =>
    Effect.gen(function* filterTitles() {
      const memory = yield* makeMemoryJobStore;

      const titles = [
        "Product Manager",
        "Staff Software Engineer",
        "VP of Engineering",
      ];

      const feeds = PostingFeeds.of({
        catalog: [onlyFeed],
        fetch: () =>
          Effect.succeed(
            pipe(
              titles,
              Array.map((title, index) => ({
                ...postingFor(`t${index}`),
                title,
              }))
            )
          ),
      });

      yield* runIngest({ feedConcurrency: 1, feedsPerRun: 1 }).pipe(
        Effect.provide(
          Layer.merge(memory.layer, Layer.succeed(PostingFeeds, feeds))
        )
      );

      expect(
        pipe(
          memory.jobs(),
          Array.map((job) => job.title)
        )
      ).toStrictEqual(["VP of Engineering"]);
    })
  );
});
