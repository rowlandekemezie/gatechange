import { describe, expect, it } from "@effect/vitest";
import {
  Account,
  AgentTokenLimit,
  AgentTokenStore,
  agentTokens,
  CurrentViewer,
  issueAgentToken,
  MAX_AGENT_TOKENS,
  ProRequired,
  revokeAgentToken,
  secretHashOf,
  Unauthorized,
  Viewer,
} from "@rat-stack/core";
import type { BillingStore, ViewerValue } from "@rat-stack/core";
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
  body: Effect.Effect<A, E, AgentTokenStore | BillingStore | SqlExecutor>
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
