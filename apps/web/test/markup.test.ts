import { describe, expect, it } from "@effect/vitest";
import type { JobValue } from "@rat-stack/core/contracts";
import { DateTime, Option, pipe } from "effect";

import { allowedOrUnstated, jobPostingOf } from "../src/server/markup.js";

const SEEN = 1_760_000_000_000;

const DAY_MILLIS = 86_400_000;

const longOpen: JobValue = {
  arrangement: "Remote",
  company: "Acme",
  feed: "ashby:acme",
  firstSeenAt: SEEN,
  id: "ashby:acme:1",
  lastSeenAt: SEEN,
  location: "Remote - Canada",
  postedAt: SEEN - 106 * DAY_MILLIS,
  region: "RemoteCanada",
  relevance: 50,
  role: "EngineeringManager",
  salary: null,
  source: "Ashby",
  title: "Engineering Manager",
  url: "https://jobs.example/1",
};

describe("job posting markup", () => {
  it("a long-open role a board still lists is valid after it was last seen", () => {
    const posting = jobPostingOf(
      longOpen,
      "https://jobs.rowlandekemezie.com/jobs/1",
      allowedOrUnstated
    );

    expect(
      pipe(
        posting,
        Option.map(({ validThrough }) => validThrough)
      )
    ).toStrictEqual(
      Option.some(
        DateTime.formatIso(DateTime.makeUnsafe(SEEN + 30 * DAY_MILLIS))
      )
    );
  });

  it("a window feed's role is valid only until its hold ends, however recently it was seen", () => {
    const postedAt = SEEN - 29 * DAY_MILLIS;

    const posting = jobPostingOf(
      {
        ...longOpen,
        feed: "jobicy:engineering-manager",
        id: "jobicy:engineering-manager:1",
        postedAt,
        source: "Jobicy",
      },
      "https://jobs.rowlandekemezie.com/jobs/2",
      allowedOrUnstated
    );

    expect(
      pipe(
        posting,
        Option.map(({ validThrough }) => validThrough)
      )
    ).toStrictEqual(
      Option.some(
        DateTime.formatIso(DateTime.makeUnsafe(postedAt + 30 * DAY_MILLIS))
      )
    );
  });

  it("a window feed's role still listed past its hold is valid through its last sighting", () => {
    const posting = jobPostingOf(
      {
        ...longOpen,
        feed: "jobicy:engineering-manager",
        id: "jobicy:engineering-manager:3",
        postedAt: SEEN - 40 * DAY_MILLIS,
        source: "Jobicy",
      },
      "https://jobs.rowlandekemezie.com/jobs/3",
      allowedOrUnstated
    );

    expect(
      pipe(
        posting,
        Option.map(({ validThrough }) => validThrough)
      )
    ).toStrictEqual(
      Option.some(DateTime.formatIso(DateTime.makeUnsafe(SEEN + DAY_MILLIS)))
    );
  });
});
