import { describe, expect, it } from "@effect/vitest";
import type { TrackedJobValue } from "@rat-stack/core/contracts";
import { Effect, Option } from "effect";
import { renderToString } from "foldkit/experimental/server";
import { fromString } from "foldkit/url";

import { application } from "../src/client/application.js";
import {
  ImportOffer,
  Preload,
  TrackerState,
} from "../src/client/board/model.js";
import type {
  MarkedJobValue,
  TrackerStateValue,
} from "../src/client/board/model.js";
import { init } from "../src/client/board/update.js";
import { jobRouter } from "../src/client/route.js";
import { jobTitle } from "../src/features/job/view.js";

const ORIGIN = "https://jobs.example";

const ID = "jobicy:engineering-manager:151629";

const POSTING = "https://jobicy.com/jobs/151629-engineering-manager";

const mark = (url: string): MarkedJobValue => ({
  company: "RevenueCat",
  id: ID,
  kind: "Saved",
  location: "Americas",
  title: "Engineering Manager, RC Capital",
  url,
});

const tracked: TrackedJobValue = {
  jobId: ID,
  listed: false,
  movedAt: 1_760_000_000_000,
  notes: "",
  savedAt: 1_760_000_000_000,
  snapshot: {
    company: "RevenueCat",
    location: "Americas",
    title: "Engineering Manager, RC Capital",
    url: POSTING,
  },
  stage: "Interviewing",
};

const remote = (jobs: readonly TrackedJobValue[]) =>
  TrackerState.Remote({
    adding: [],
    jobs,
    loaded: true,
    offer: ImportOffer.None(),
    problem: Option.none(),
  });

const renderGoneRole = (
  marks: readonly MarkedJobValue[],
  tracker?: TrackerStateValue
) =>
  renderToString(
    {
      ...application,
      init: (...args: Parameters<typeof application.init>) => {
        const started = application.init(...args);

        return {
          ...started,
          model: {
            ...started.model,
            marks,
            tracker: tracker ?? started.model.tracker,
          },
        };
      },
    },
    {
      flags: { origin: ORIGIN, preload: Preload.JobMissing() },
      url: `${ORIGIN}${jobRouter({ id: ID })}`,
    }
  ).pipe(Effect.map(({ html }) => html));

const expectSavedRole = (html: string) => {
  expect(html).toContain("Engineering Manager, RC Capital");
  expect(html).toContain("RevenueCat");
  expect(html).toContain("Americas");
  expect(html).toContain(`href="${POSTING}"`);
  expect(html).not.toContain("This role is no longer on the board</h1>");
};

describe("a shortlisted role whose row is gone", () => {
  it.effect("shows what a signed-out viewer saved in this browser", () =>
    Effect.map(renderGoneRole([mark(POSTING)]), expectSavedRole)
  );

  it.effect("shows what a member's tracker saved", () =>
    Effect.map(renderGoneRole([], remote([tracked])), expectSavedRole)
  );

  it.effect("leaves the link out when the saved URL is not off-site", () =>
    Effect.map(
      renderGoneRole([mark("https://jobs.rowlandekemezie.com/api/auth/x")]),
      (html) => {
        expect(html).toContain("Engineering Manager, RC Capital");
        expect(html).not.toContain("Open the original posting");
        expect(html).not.toContain("/api/auth/x");
      }
    )
  );

  it.effect("a role nobody saved still reads as gone", () =>
    Effect.map(renderGoneRole([]), (html) => {
      expect(html).toContain("This role is no longer on the board");
    })
  );

  it("titles the page with the saved role only when one is saved", () => {
    const { model } = init(
      { origin: ORIGIN, preload: Preload.JobMissing() },
      Option.getOrThrow(fromString(`${ORIGIN}${jobRouter({ id: ID })}`))
    );

    expect(jobTitle(model)).toBe("Role not found");
    expect(jobTitle({ ...model, marks: [mark(POSTING)] })).toBe(
      "Engineering Manager, RC Capital at RevenueCat"
    );
  });
});
