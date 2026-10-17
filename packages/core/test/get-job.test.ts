import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import { getJob, getJobContract, JobStore } from "../src/index.js";
import type { JobValue } from "../src/index.js";
import { makeMemoryJobStore } from "./memory-job-store.js";

const listed: JobValue = {
  arrangement: "Remote",
  company: "Moniepoint",
  feed: "himalayas:engineering-manager",
  firstSeenAt: 1_760_000_000_000,
  id: "himalayas:https://himalayas.app/companies/moniepoint/jobs/engineering-manager-9245044553",
  lastSeenAt: 1_760_000_000_000,
  location: "Remote, Canada",
  postedAt: 1_760_000_000_000,
  region: "RemoteCanada",
  relevance: 12,
  role: "EngineeringManager",
  salary: null,
  source: "Himalayas",
  title: "Engineering Manager",
  url: "https://himalayas.app/companies/moniepoint/jobs/engineering-manager-9245044553",
};

const encodeOutput = Schema.encodeSync(getJobContract.output);

const lookUp = (id: string) =>
  Effect.gen(function* lookUpJob() {
    const memory = yield* makeMemoryJobStore;

    return yield* Effect.gen(function* listThenFind() {
      const store = yield* JobStore;
      yield* store.replaceFeed(listed.feed, [listed], listed.lastSeenAt);

      return yield* getJob.handler({ id });
    }).pipe(Effect.provide(memory.layer));
  });

describe("getJob", () => {
  it.effect("returns a listed job by id", () =>
    Effect.gen(function* listedJob() {
      const found = yield* lookUp(listed.id);

      expect(found).toStrictEqual(Option.some(listed));
      expect(encodeOutput(found)).toStrictEqual(listed);
    })
  );

  it.effect("returns none for an unknown id, sent as null on the wire", () =>
    Effect.gen(function* unknownJob() {
      const missing = yield* lookUp("greenhouse:stripe:404");

      expect(missing).toStrictEqual(Option.none());
      expect(encodeOutput(missing)).toBeNull();
    })
  );
});
