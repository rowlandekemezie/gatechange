import {
  Array,
  Clock,
  Console,
  Data,
  Effect,
  Layer,
  pipe,
  Schema,
} from "effect";
import type { Option } from "effect";
import { FetchHttpClient } from "effect/http";

import { jobsFromPostings, PostingFeeds } from "../packages/core/dist/index.js";
import type { CompanyBoardValue } from "../packages/job-sources/dist/boards.js";
import {
  boardFeed,
  CompanyAts,
  companyBoards,
  feedRefOf,
  postingFeedsLayer,
  USER_AGENT,
} from "../packages/job-sources/dist/index.js";

const PROBE_DELAY = "1 second";

const ATS_ORDER: readonly (typeof CompanyAts.Type)[] = [
  "greenhouse",
  "ashby",
  "lever",
  "workable",
  "smartrecruiters",
];

const Candidate = Schema.Struct({
  ats: Schema.optional(CompanyAts),
  name: Schema.NonEmptyString,
  slug: Schema.NonEmptyString,
});

type CandidateValue = typeof Candidate.Type;

type ProbeValue = Data.TaggedEnum<{
  Dead: { readonly board: CompanyBoardValue; readonly reason: string };
  Live: {
    readonly board: CompanyBoardValue;
    readonly listed: number;
    readonly roles: number;
  };
}>;

const Probe = Data.taggedEnum<ProbeValue>();

const candidateOf = (argument: string): Option.Option<CandidateValue> => {
  const [target = "", name] = argument.split("=", 2);
  const [first = "", second] = target.split(":", 2);
  const slug = second ?? first;

  return Schema.decodeUnknownOption(Candidate)({
    ats: second === undefined ? undefined : first,
    name: name ?? slug,
    slug,
  });
};

const probe = (board: CompanyBoardValue) =>
  Effect.gen(function* probeBoard() {
    const feed = feedRefOf(boardFeed(board));
    const feeds = yield* PostingFeeds;
    const now = yield* Clock.currentTimeMillis;

    return yield* feeds.fetch(feed).pipe(
      Effect.map((postings) =>
        Probe.Live({
          board,
          listed: postings.length,
          roles: jobsFromPostings(feed, postings, now).length,
        })
      ),
      Effect.catch((error) =>
        Effect.succeed(Probe.Dead({ board, reason: error.message }))
      )
    );
  }).pipe(
    Effect.provide(
      postingFeedsLayer([board]).pipe(Layer.provide(FetchHttpClient.layer))
    ),
    Effect.tap(() => Effect.sleep(PROBE_DELAY))
  );

const isListing = Probe.$match({
  Dead: () => false,
  Live: ({ listed }) => listed > 0,
});

const discover = (candidate: CandidateValue) =>
  Effect.gen(function* discoverCandidate() {
    const atsToProbe =
      candidate.ats === undefined ? ATS_ORDER : [candidate.ats];

    let last: ProbeValue | undefined;

    for (const ats of atsToProbe) {
      last = yield* probe({ ats, name: candidate.name, slug: candidate.slug });

      if (isListing(last)) {
        return last;
      }
    }

    return last;
  });

const lineOf = Probe.$match({
  Dead: ({ board, reason }) =>
    [
      "dead",
      board.ats,
      board.slug,
      board.name,
      "0",
      reason.replaceAll(/\s+/gu, " "),
    ].join("\t"),
  Live: ({ board, listed, roles }) =>
    [
      roles > 0 ? "verified" : "no-roles",
      board.ats,
      board.slug,
      board.name,
      String(roles),
      String(listed),
    ].join("\t"),
});

const program = Effect.gen(function* discoverBoards() {
  const named = process.argv.slice(2);

  const candidates: readonly CandidateValue[] =
    named.length === 0
      ? companyBoards
      : pipe(named, Array.map(candidateOf), Array.getSomes);

  yield* Console.error(
    `probing ${candidates.length} candidates serially as ${USER_AGENT}`
  );
  yield* Console.log("status\tats\tslug\tname\troles\tlisted");

  for (const candidate of candidates) {
    const result = yield* discover(candidate);

    if (result !== undefined) {
      yield* Console.log(lineOf(result));
    }
  }
});

await Effect.runPromise(program);
