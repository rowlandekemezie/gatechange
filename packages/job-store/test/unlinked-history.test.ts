import { describe, expect, it } from "@effect/vitest";
import {
  DAY_MILLIS,
  FeedUnavailable,
  JobStore,
  PostingFeeds,
  runIngest,
  SourceName,
} from "@rat-stack/core";
import type { FeedRef, JobValue, PostingValue } from "@rat-stack/core";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";

import { sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const original: JobValue = {
  arrangement: "Remote",
  company: "Acme",
  feed: "greenhouse:acme",
  firstSeenAt: NOW,
  id: "original",
  lastSeenAt: NOW,
  location: "Remote - Canada",
  postedAt: NOW,
  region: "RemoteCanada",
  relevance: 50,
  role: "EngineeringManager",
  salary: null,
  source: "Greenhouse",
  title: "Engineering Manager",
  url: "https://jobs.example/original",
};

const posting = (company: string): PostingValue => ({
  company,
  externalId: "hidden",
  location: "Remote - Canada",
  postedAt: null,
  salary: null,
  title: original.title,
  url: "/invalid-apply-link",
  workplace: "Remote",
});

const cases: readonly (readonly [string, FeedRef, string, boolean])[] = [
  [
    "aggregator company",
    {
      company: Option.none(),
      key: "remoteok:test",
      minIntervalMinutes: 1,
      source: "RemoteOK",
    },
    "Acme",
    false,
  ],
  [
    "forbidden paid aggregator company",
    {
      company: Option.none(),
      key: "remotive:test",
      minIntervalMinutes: 1,
      source: "Remotive",
    },
    "Acme",
    false,
  ],
  [
    "catalog company",
    {
      company: Option.some("Acme"),
      key: "greenhouse:test",
      minIntervalMinutes: 1,
      source: "Greenhouse",
    },
    "",
    true,
  ],
  [
    "catalog company with matching payload name",
    {
      company: Option.some("Acme"),
      key: "greenhouse:test",
      minIntervalMinutes: 1,
      source: "Greenhouse",
    },
    "Acme",
    false,
  ],
  [
    "catalog company overridden by payload",
    {
      company: Option.some("Acme"),
      key: "greenhouse:test",
      minIntervalMinutes: 1,
      source: "Greenhouse",
    },
    "Another Company",
    false,
  ],
];

describe("unlinked company-history provenance", () => {
  it.effect.each(cases)(
    "records only catalog-derived sightings: %s",
    ([, feed, company, trusted]) =>
      Effect.gen(function* provenance() {
        const database = yield* sqlJsJobStore;
        const now = NOW + 8 * DAY_MILLIS;
        yield* Effect.gen(function* runWithStore() {
          const store = yield* JobStore;
          yield* store.replaceFeed(original.feed, [original], NOW);
          yield* store.replaceFeed(original.feed, [], NOW + DAY_MILLIS);
          yield* store.replaceFeed(
            feed.key,
            [
              {
                ...original,
                company: "Old Company",
                feed: feed.key,
                id: "old",
                source: feed.source,
              },
            ],
            NOW
          );
          const before = yield* store.historyOf(original);
          const intelBefore = yield* store.companyRecords("acme", now);
          yield* TestClock.setTime(now);

          const feeds = PostingFeeds.of({
            catalog: [feed],
            fetch: () =>
              Effect.succeed([
                posting(company),
                {
                  ...posting("Visible Company"),
                  externalId: "visible",
                  title: "Director of Engineering",
                  url: "https://jobs.example/visible",
                },
              ]),
          });

          const run = yield* runIngest({
            feedConcurrency: 1,
            feedsPerRun: 1,
          }).pipe(Effect.provideService(PostingFeeds, feeds));

          const after = yield* store.historyOf(original);
          const intelAfter = yield* store.companyRecords("acme", now);

          const override = yield* store.historyOf({
            company: "Another Company",
            title: original.title,
          });

          const listed = yield* store.list(
            {
              limit: 50,
              maxAgeDays: 30,
              offset: 0,
              regions: [],
              roles: [],
              salaryFloor: null,
              salaryListed: false,
              search: "",
              seniorities: [],
              sort: "Newest",
            },
            now,
            SourceName.literals
          );

          if (trusted) {
            expect(after).toStrictEqual(
              Option.some({
                firstSeenAt: NOW,
                lastSeenAt: now,
                reposts: 1,
                sightings: 2,
              })
            );
            expect(intelAfter.history).not.toStrictEqual(intelBefore.history);
          } else {
            expect(after).toStrictEqual(before);
            expect(intelAfter).toStrictEqual(intelBefore);
          }

          expect(override).toStrictEqual(Option.none());
          expect(
            (yield* store.companyRecords("another-company", now)).history
          ).toHaveLength(0);
          expect(listed.jobs.map((job) => job.id)).toStrictEqual([
            `${feed.key}:visible`,
          ]);
          expect(run.receipt).toMatchObject({
            feedsAttempted: 1,
            feedsFailed: 0,
            jobsPruned: 1,
            jobsUpserted: 1,
            outcome: "Succeeded",
          });
          expect(run.outcomes[0]).toMatchObject({
            error: null,
            key: feed.key,
            pruned: 1,
            upserted: 1,
          });
        }).pipe(Effect.provide(database));
      })
  );

  it.effect("a failed catalog fetch changes neither listings nor history", () =>
    Effect.gen(function* failedFetch() {
      const database = yield* sqlJsJobStore;
      yield* Effect.gen(function* runWithStore() {
        const store = yield* JobStore;
        yield* store.replaceFeed(original.feed, [original], NOW);
        const before = yield* store.historyOf(original);
        yield* TestClock.setTime(NOW + DAY_MILLIS);

        const feed: FeedRef = {
          company: Option.some("Acme"),
          key: original.feed,
          minIntervalMinutes: 1,
          source: "Greenhouse",
        };

        const feeds = PostingFeeds.of({
          catalog: [feed],
          fetch: () =>
            Effect.fail(
              new FeedUnavailable({ feed: feed.key, message: "Unavailable" })
            ),
        });

        const run = yield* runIngest({
          feedConcurrency: 1,
          feedsPerRun: 1,
        }).pipe(Effect.provideService(PostingFeeds, feeds));

        expect(yield* store.find(original.id)).toStrictEqual(
          Option.some({ ...original, enrichment: null })
        );
        expect(yield* store.historyOf(original)).toStrictEqual(before);
        expect(run.receipt).toMatchObject({
          feedsAttempted: 1,
          feedsFailed: 1,
          jobsPruned: 0,
          jobsUpserted: 0,
          outcome: "Failed",
        });
      }).pipe(Effect.provide(database));
    })
  );
});
