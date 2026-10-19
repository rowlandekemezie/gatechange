import { describe, expect, it } from "@effect/vitest";
import { toRpc } from "@rat-stack/capability/rpc";
import { Effect, Layer, Option, Schema } from "effect";
import { RpcTest } from "effect/rpc";

import {
  Account,
  AlertStore,
  CurrentViewer,
  deleteSearch,
  savedSearches,
  saveSearch,
  SavedSearchId,
  SavedSearchLimit,
  Viewer,
} from "../src/index.js";
import type {
  SavedSearchValue,
  SearchFiltersValue,
  ViewerValue,
} from "../src/index.js";

const member = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

const filters: SearchFiltersValue = {
  regions: ["RemoteCanada"],
  roles: ["Director"],
  search: "platform",
};

const projection = toRpc([saveSearch, savedSearches, deleteSearch]);

const storeWith = (
  saved: Map<string, SavedSearchValue>,
  limit: number
): Layer.Layer<AlertStore> =>
  Layer.succeed(
    AlertStore,
    AlertStore.of({
      claimDigest: () => Effect.die("unused"),
      deleteSearch: (owner, id) =>
        Effect.sync(() => {
          if (saved.get(id)?.owner === owner) {
            saved.delete(id);
          }
        }),
      dueRecipients: () => Effect.die("unused"),
      jobsSeenSince: () => Effect.die("unused"),
      markSent: () => Effect.die("unused"),
      releaseDigest: () => Effect.die("unused"),
      saveSearch: (owner, searchFilters, createdAt) =>
        Effect.sync(() => {
          if (saved.size >= limit) {
            return Option.none();
          }

          const search: SavedSearchValue = {
            createdAt,
            filters: searchFilters,
            frequency: "Weekly",
            id: SavedSearchId.make(`search-${saved.size}`),
            owner,
          };

          saved.set(search.id, search);

          return Option.some(search);
        }),
      searchesOf: (owner) =>
        Effect.sync(() =>
          [...saved.values()].filter((search) => search.owner === owner)
        ),
      sendsSince: () => Effect.die("unused"),
      unsubscribe: () => Effect.die("unused"),
    })
  );

const clientAs = (viewer: ViewerValue, store: Layer.Layer<AlertStore>) =>
  RpcTest.makeClient(projection.group).pipe(
    Effect.provide(
      projection.layer.pipe(
        Layer.provide(store),
        Layer.provide(Layer.succeed(CurrentViewer, viewer))
      )
    )
  );

describe("saved searches", () => {
  it.effect(
    "refuses every saved-search capability for an anonymous viewer and touches no store",
    () =>
      Effect.gen(function* anonymous() {
        const saved = new Map<string, SavedSearchValue>();

        const client = yield* clientAs(
          Viewer.Anonymous(),
          storeWith(saved, 10)
        );

        const failures = yield* Effect.all([
          Effect.flip(client.saveSearch({ filters })),
          Effect.flip(client.savedSearches({})),
          Effect.flip(client.deleteSearch({ id: SavedSearchId.make("x") })),
        ]);

        expect(failures.map((failure) => failure._tag)).toEqual([
          "Unauthorized",
          "Unauthorized",
          "Unauthorized",
        ]);
        expect(saved.size).toBe(0);
      })
  );

  it.effect("saves a search for the signed-in member and lists it back", () =>
    Effect.gen(function* saves() {
      const saved = new Map<string, SavedSearchValue>();

      const client = yield* clientAs(
        Viewer.Member({ account: member }),
        storeWith(saved, 10)
      );

      const search = yield* client.saveSearch({ filters });

      expect([search.owner, search.filters]).toEqual([member.id, filters]);
      expect(yield* client.savedSearches({})).toEqual([search]);

      yield* client.deleteSearch({ id: search.id });

      expect(yield* client.savedSearches({})).toEqual([]);
    })
  );

  it.effect("fails with SavedSearchLimit once the member is at the limit", () =>
    Effect.gen(function* limited() {
      const client = yield* clientAs(
        Viewer.Member({ account: member }),
        storeWith(new Map(), 0)
      );

      expect(yield* Effect.flip(client.saveSearch({ filters }))).toBeInstanceOf(
        SavedSearchLimit
      );
    })
  );
});
