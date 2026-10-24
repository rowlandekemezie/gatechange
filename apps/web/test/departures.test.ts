import { describe, expect, it } from "@effect/vitest";
import type {
  ListedJobValue,
  ListingStatusValue,
} from "@rat-stack/core/contracts";
import { Effect } from "effect";
import { renderToString } from "foldkit/experimental/server";

import { application } from "../src/client/application.js";
import { JobsState, Preload } from "../src/client/board/model.js";

const ORIGIN = "https://jobs.example";

const NOW = 1_760_500_000_000;

const listed = (status: ListingStatusValue): ListedJobValue => ({
  arrangement: "Remote",
  company: `Acme ${status}`,
  daysOpen: 0,
  enrichment: null,
  feed: "Greenhouse:acme",
  firstSeenAt: NOW - 3_600_000,
  id: `greenhouse-${status}`,
  lastSeenAt: NOW,
  location: "Remote, Canada",
  postedAt: NOW - 3 * 86_400_000,
  region: "RemoteCanada",
  relevance: 10,
  reposts: 0,
  role: "Director",
  salary: "$250k",
  source: "Greenhouse",
  status,
  title: `Director of Engineering ${status}`,
  url: `https://boards.example/${status}`,
});

const renderBoard = (jobs: readonly ListedJobValue[]) =>
  renderToString(
    {
      ...application,
      init: (...args: Parameters<typeof application.init>) => {
        const started = application.init(...args);

        return {
          ...started,
          model: {
            ...started.model,
            jobs: JobsState.Loaded({
              generatedAt: NOW,
              jobs,
              total: jobs.length,
            }),
          },
        };
      },
    },
    { flags: { origin: ORIGIN, preload: Preload.Nothing() }, url: ORIGIN }
  ).pipe(Effect.map(({ html }) => html));

describe("departures board", () => {
  it.effect.each([
    ["new", "New"],
    ["boarding", "Boarding"],
    ["on_time", "On time"],
  ] as const)("labels a %s listing %s", ([status, label]) =>
    Effect.map(renderBoard([listed(status)]), (html) => {
      expect(html).toContain(
        `<span class="tile cell-status status-${status}">${label}</span>`
      );
    })
  );

  it.effect("keeps the role, source and tracking controls on each row", () =>
    Effect.map(renderBoard([listed("boarding")]), (html) => {
      expect(html).toMatch(
        /<a class="departure-tiles" href="\/jobs\/[^"]+">.*Director of Engineering boarding/su
      );
      expect(html).toContain('href="https://boards.example/boarding"');
      expect(html).toContain("$250k");
      expect(html).toContain("3d ago");
      expect(html).toContain(
        'aria-label="Track Director of Engineering boarding'
      );
    })
  );

  it.effect("explains New and Boarding under the board", () =>
    Effect.map(renderBoard([listed("new")]), (html) => {
      expect(html).toContain("first seen in the last 24 hours");
      expect(html).toContain("posted this week");
    })
  );
});
