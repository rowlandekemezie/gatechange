import { describe, expect, it } from "@effect/vitest";
import { toRpc } from "@rat-stack/capability/rpc";
import { Effect, Layer, Schema } from "effect";
import { RpcTest } from "effect/rpc";

import {
  account,
  Account,
  AccountStore,
  CurrentViewer,
  signInOptions,
  Unauthorized,
  UNAUTHORIZED_MESSAGE,
  Viewer,
} from "../src/index.js";
import type { ViewerValue } from "../src/index.js";

const member = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

const projection = toRpc([account, signInOptions]);

const store = Layer.succeed(
  AccountStore,
  AccountStore.of({
    signInOptions: { socialProviders: ["github"] },
    viewerOf: () => Effect.succeed(Viewer.Anonymous()),
  })
);

const clientAs = (viewer: ViewerValue) =>
  RpcTest.makeClient(projection.group).pipe(
    Effect.provide(
      projection.layer.pipe(
        Layer.provide(store),
        Layer.provide(Layer.succeed(CurrentViewer, viewer))
      )
    )
  );

describe("viewer", () => {
  it.effect(
    "refuses the member-only account capability for an anonymous viewer with Unauthorized",
    () =>
      Effect.gen(function* anonymousAccount() {
        const client = yield* clientAs(Viewer.Anonymous());
        const failure = yield* Effect.flip(client.account({}));

        expect(failure).toStrictEqual(
          new Unauthorized({ message: UNAUTHORIZED_MESSAGE })
        );
      })
  );

  it.effect("returns the member's own account", () =>
    Effect.gen(function* memberAccount() {
      const client = yield* clientAs(Viewer.Member({ account: member }));

      expect(yield* client.account({})).toStrictEqual(member);
    })
  );

  it.effect("tells anonymous viewers which social providers are on", () =>
    Effect.gen(function* anonymousOptions() {
      const client = yield* clientAs(Viewer.Anonymous());

      expect(yield* client.signInOptions({})).toStrictEqual({
        socialProviders: ["github"],
      });
    })
  );
});
