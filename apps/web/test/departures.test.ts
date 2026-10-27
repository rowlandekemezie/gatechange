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

const renderBoard = (jobs: readonly ListedJobValue[], total = jobs.length) =>
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
              total,
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

  it.effect.each([
    [
      "a salary band",
      {
        enrichment: {
          board: null,
          enrichedAt: NOW,
          handsOn: null,
          model: "test-model",
          promptVersion: 2,
          remotePolicy: null,
          reportsTo: null,
          salary: { currency: "USD", max: 310_000, min: 260_000 },
          seniority: null,
          teamSize: null,
        },
      },
      "$260K+",
    ],
    ["a stated range", { salary: "$180k – $210k" }, "$180k+"],
  ] as const)("tags the role with %s", ([, pay, tag]) =>
    Effect.map(renderBoard([{ ...listed("new"), ...pay }]), (html) => {
      expect(
        /class="role-pay"[^>]*>(?<pay>[^<]*)</u.exec(html)?.groups?.pay
      ).toBe(tag);
    })
  );

  it.effect("explains New and Boarding under the board", () =>
    Effect.map(renderBoard([listed("new")]), (html) => {
      expect(html).toContain("first seen in the last 24 hours");
      expect(html).toContain("posted this week");
    })
  );

  it.effect.each([
    [100, "Show 25 more"],
    [4, "Show 3 more"],
  ] as const)("offers the next page of %i matches as %s", ([total, label]) =>
    Effect.map(renderBoard([listed("new")], total), (html) => {
      expect(html).toMatch(
        new RegExp(`<button[^>]*class="more"[^>]*>${label}</button>`, "u")
      );
    })
  );
});
