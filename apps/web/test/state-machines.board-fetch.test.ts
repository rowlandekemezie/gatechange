import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { Message } from "../src/client/board/message.js";
import { JobsState, MoreState } from "../src/client/board/model.js";
import {
  leftTo,
  listedOf,
  named,
  sentAll,
  started,
  walked,
} from "./state-machines.support.js";

const pageOf = (...ids: readonly string[]) => ({
  generatedAt: 1_760_000_000_000,
  jobs: ids.map(listedOf),
  total: 10,
});

const loadedBoard = () => {
  const opened = started("/");

  return sentAll(opened, [
    Message.SucceededFetchJobs({
      generation: opened.model.generation,
      page: pageOf("a1"),
    }),
  ]);
};

const idsOf = (jobs: typeof JobsState.Type) =>
  Schema.is(JobsState.Loaded)(jobs) ? jobs.jobs.map((job) => job.id) : [];

describe("BoardFetch model replay", () => {
  it("holds ListMatchesFilters: a reply for the old filters never fills the new list", () => {
    const opened = started("/");
    const firstGeneration = opened.model.generation;

    const changed = sentAll(opened, [
      Message.ToggledRole({ role: "Director" }),
    ]);

    const stale = sentAll(changed, [
      Message.SucceededFetchJobs({
        generation: firstGeneration,
        page: pageOf("a1"),
      }),
    ]);

    expect(Schema.is(JobsState.Loaded)(stale.model.jobs)).toBe(false);

    const fresh = sentAll(stale, [
      Message.SucceededFetchJobs({
        generation: changed.model.generation,
        page: pageOf("b1"),
      }),
    ]);

    expect(idsOf(fresh.model.jobs)).toStrictEqual(["b1"]);
  });

  it("holds ShowMoreSettles: changing filters while Show more loads clears it and drops the late page", () => {
    const loaded = loadedBoard();
    const more = sentAll(loaded, [Message.ClickedLoadMore()]);

    expect(more.model.more).toStrictEqual(MoreState.Loading());

    const changed = sentAll(more, [Message.ToggledRole({ role: "Director" })]);

    const late = sentAll(changed, [
      Message.SucceededFetchMoreJobs({
        generation: loaded.model.generation,
        page: pageOf("a2"),
      }),
      Message.FailedFetchMoreJobs({ generation: loaded.model.generation }),
    ]);

    expect(late.model.more).toStrictEqual(MoreState.Idle());
    expect(idsOf(late.model.jobs)).toStrictEqual([]);
  });

  it("holds ListSettles: a failed list can be retried to a loaded list", () => {
    const opened = started("/");

    const failed = sentAll(opened, [
      Message.FailedFetchJobs({
        generation: opened.model.generation,
        message: "Could not reach the job list.",
      }),
    ]);

    const retried = sentAll(failed, [Message.ClickedRetry()]);

    expect(named(retried.commands, "FetchJobs")).toHaveLength(1);

    const done = sentAll(retried, [
      Message.SucceededFetchJobs({
        generation: retried.model.generation,
        page: pageOf("a1"),
      }),
    ]);

    expect(idsOf(done.model.jobs)).toStrictEqual(["a1"]);
  });

  it("holds ListMatchesFilters on a double tap of Show more: rows are not listed twice", () => {
    const loaded = loadedBoard();

    const tapped = walked(loaded, [
      Message.ClickedLoadMore(),
      Message.ClickedLoadMore(),
    ]);

    expect(named(tapped.all, "FetchMoreJobs")).toHaveLength(2);

    const done = sentAll(tapped.last, [
      Message.SucceededFetchMoreJobs({
        generation: loaded.model.generation,
        page: pageOf("a2"),
      }),
      Message.SucceededFetchMoreJobs({
        generation: loaded.model.generation,
        page: pageOf("a2"),
      }),
    ]);

    expect(idsOf(done.model.jobs)).toStrictEqual(["a1", "a2"]);
  });

  it("holds: opening a job and coming back keeps the list without a refetch", () => {
    const back = walked(loadedBoard(), [leftTo("/jobs/a1"), leftTo("/")]);

    expect(named(back.all, "FetchJobs")).toHaveLength(0);
    expect(idsOf(back.last.model.jobs)).toStrictEqual(["a1"]);
  });
});
