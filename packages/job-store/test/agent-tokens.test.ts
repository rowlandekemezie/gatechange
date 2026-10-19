import { describe, expect, it } from "@effect/vitest";
import {
  Account,
  AgentTokenLimit,
  AgentTokenStore,
  agentSources,
  agentTokens,
  CurrentViewer,
  getJob,
  issueAgentToken,
  JobStore,
  listJobs,
  MAX_AGENT_TOKENS,
  ProRequired,
  revokeAgentToken,
  secretHashOf,
  ServedSources,
  Unauthorized,
  Viewer,
} from "@rat-stack/core";
import type {
  JobQueryValue,
  JobValue,
  ViewerValue,
  BillingStore,
} from "@rat-stack/core";
import { Effect, Layer, Option, Schema } from "effect";

import {
  agentTokenStoreLayer,
  billingStoreLayer,
  SqlExecutor,
  statement,
} from "../src/index.js";
import { sqlJsJobStore } from "./sqljs-executor.js";

const NOW = 1_760_000_000_000;

const memberOf = (id: string) =>
  Viewer.Member({
    account: Schema.decodeSync(Account)({
      email: `${id}@example.com`,
      id,
      name: id,
    }),
  });

const ada = memberOf("user_ada");

const grace = memberOf("user_grace");

const as =
  (viewer: ViewerValue) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, CurrentViewer, viewer);

const addMember = (id: string, pro: boolean) =>
  SqlExecutor.use((sql) =>
    sql.batch("addMember", [
      statement(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)`,
        [id, id, `${id}@example.com`]
      ),
      ...(pro
        ? [
            statement(
              `INSERT INTO subscriptions (subscription_id, account_id, plan, status, period_end, cancel_at_period_end, event_created, event_rank, event_id)
VALUES (?, ?, 'Monthly', 'active', ?, 0, 1, 0, 'evt_1')`,
              [`sub_${id}`, id, NOW * 2]
            ),
          ]
        : []),
    ])
  );

const withStores = <A, E>(
  body: Effect.Effect<
    A,
    E,
    AgentTokenStore | BillingStore | JobStore | SqlExecutor
  >
) =>
  Effect.gen(function* provideStores() {
    const base = yield* sqlJsJobStore;

    return yield* body.pipe(
      Effect.provide(
        Layer.mergeAll(agentTokenStoreLayer, billingStoreLayer).pipe(
          Layer.provideMerge(base)
        )
      )
    );
  });

const holderOf = (secret: string) =>
  secretHashOf(secret).pipe(
    Effect.flatMap((hash) =>
      AgentTokenStore.use((store) => store.holderOf(hash))
    ),
    Effect.map(Option.map((account) => account.id))
  );

describe("agent tokens", () => {
  it.effect(
    "a Pro member's issued token names its holder until it is revoked, and its secret is never listed",
    () =>
      withStores(
        Effect.gen(function* issueAndRevoke() {
          yield* addMember("user_ada", true);

          const issued = yield* issueAgentToken.handler({ label: "Claude" });

          expect(issued.secret).toMatch(/^jobs_pat_[\w-]{43}$/u);
          expect(yield* holderOf(issued.secret)).toStrictEqual(
            Option.some("user_ada")
          );

          const listed = yield* agentTokens.handler({});

          expect(listed).toStrictEqual([issued.token]);
          expect(JSON.stringify(listed)).not.toContain(issued.secret);

          yield* revokeAgentToken.handler({ id: issued.token.id });

          expect(yield* holderOf(issued.secret)).toStrictEqual(Option.none());
          expect(yield* agentTokens.handler({})).toStrictEqual([]);
        }).pipe(as(ada))
      )
  );

  it.effect("a Free member cannot issue a token", () =>
    withStores(
      Effect.gen(function* freeMember() {
        yield* addMember("user_ada", false);

        const refused = yield* Effect.flip(
          issueAgentToken.handler({ label: "Claude" })
        );

        expect(refused).toBeInstanceOf(ProRequired);
        expect(yield* agentTokens.handler({})).toStrictEqual([]);
      }).pipe(as(ada))
    )
  );

  it.effect("a signed-out viewer cannot issue or list tokens", () =>
    withStores(
      Effect.gen(function* anonymous() {
        expect(
          yield* Effect.flip(issueAgentToken.handler({ label: "Claude" }))
        ).toBeInstanceOf(Unauthorized);
        expect(yield* Effect.flip(agentTokens.handler({}))).toBeInstanceOf(
          Unauthorized
        );
      }).pipe(as(Viewer.Anonymous()))
    )
  );

  it.effect(`a member holds at most ${MAX_AGENT_TOKENS} tokens at once`, () =>
    withStores(
      Effect.gen(function* limit() {
        yield* addMember("user_ada", true);

        const issued = yield* Effect.forEach(
          Array.from({ length: MAX_AGENT_TOKENS }, (_, index) => index),
          (index) => issueAgentToken.handler({ label: `agent ${index}` })
        );

        const refused = yield* Effect.flip(
          issueAgentToken.handler({ label: "one more" })
        );

        expect(refused).toStrictEqual(
          new AgentTokenLimit({ limit: MAX_AGENT_TOKENS })
        );

        const [first] = issued;

        if (first !== undefined) {
          yield* revokeAgentToken.handler({ id: first.token.id });
        }

        const replacement = yield* issueAgentToken.handler({
          label: "replacement",
        });

        expect(yield* holderOf(replacement.secret)).toStrictEqual(
          Option.some("user_ada")
        );
      }).pipe(as(ada))
    )
  );

  it.effect("a member cannot revoke another member's token", () =>
    withStores(
      Effect.gen(function* otherOwner() {
        yield* addMember("user_ada", true);
        yield* addMember("user_grace", true);

        const issued = yield* issueAgentToken
          .handler({ label: "Claude" })
          .pipe(as(ada));

        yield* revokeAgentToken
          .handler({ id: issued.token.id })
          .pipe(as(grace));

        expect(yield* holderOf(issued.secret)).toStrictEqual(
          Option.some("user_ada")
        );
      })
    )
  );
});

const job = (source: JobValue["source"], id: string): JobValue => ({
  arrangement: "Remote",
  company: `${source} Co`,
  feed: `${source}:all`,
  firstSeenAt: NOW,
  id,
  lastSeenAt: NOW,
  location: "Remote - Canada",
  postedAt: NOW,
  region: "RemoteCanada",
  relevance: 50,
  role: "Director",
  salary: null,
  source,
  title: `Director of Engineering ${id}`,
  url: `https://jobs.example/${id}`,
});

const query: JobQueryValue = {
  limit: 50,
  maxAgeDays: 30,
  offset: 0,
  regions: [],
  roles: [],
  salaryListed: false,
  search: "",
  sort: "Newest",
};

describe("agent sources", () => {
  it.effect(
    "an agent listing and lookup leave out every source whose terms forbid agent access",
    () =>
      withStores(
        Effect.gen(function* agentListing() {
          const store = yield* JobStore;

          const seeded = [
            job("Greenhouse", "g:1"),
            job("Jobicy", "j:1"),
            job("Remotive", "r:1"),
            job("Himalayas", "h:1"),
            job("HackerNews", "n:1"),
          ];

          for (const listing of seeded) {
            yield* store.replaceFeed(listing.feed, [listing], NOW);
          }

          const board = yield* listJobs.handler(query);

          const agents = yield* listJobs
            .handler(query)
            .pipe(Effect.provideService(ServedSources, agentSources()));

          const remotive = yield* getJob
            .handler({ id: "r:1" })
            .pipe(Effect.provideService(ServedSources, agentSources()));

          expect(board.jobs.map(({ id }) => id).toSorted()).toStrictEqual([
            "g:1",
            "h:1",
            "j:1",
            "n:1",
            "r:1",
          ]);
          expect(agents.jobs.map(({ id }) => id).toSorted()).toStrictEqual([
            "g:1",
            "j:1",
          ]);
          expect(agents.total).toBe(2);
          expect(Option.isNone(remotive)).toBe(true);
          expect(Option.isSome(yield* getJob.handler({ id: "r:1" }))).toBe(
            true
          );
        }).pipe(as(Viewer.Anonymous()))
      )
  );
});
