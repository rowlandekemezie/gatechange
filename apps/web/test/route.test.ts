import { roleLevels } from "@rat-stack/core/contracts";
import { Array, Option } from "effect";
import { fromString } from "foldkit/url";
import { describe, expect, it } from "vitest";

import {
  ageWindows,
  defaultFilters,
  regionGroups,
} from "../src/client/board/filters.js";
import type { FiltersValue } from "../src/client/board/filters.js";
import { boardUrl, jobRouter, Route, routeOfUrl } from "../src/client/route.js";

const ORIGIN = "https://jobs.example";

const routeAt = (path: string) =>
  routeOfUrl(Option.getOrThrow(fromString(`${ORIGIN}${path}`)));

const MODULUS = 2_147_483_647;

const seeded = (seed: number) => {
  let state = seed % MODULUS;

  return () => {
    state = (state * 48_271) % MODULUS;

    return state / MODULUS;
  };
};

const SEARCH_ALPHABET = [
  "a",
  "Z",
  "0",
  " ",
  ",",
  "&",
  "=",
  "?",
  "#",
  "%",
  "+",
  "/",
  ":",
  "'",
  '"',
  "<",
  ".",
  "~",
  "é",
  "漢",
  "🚀",
  "\t",
  "\n",
];

const filtersFrom = (next: () => number): FiltersValue => {
  const pick = <A>(values: readonly A[]): A =>
    Array.getUnsafe(values, Math.floor(next() * values.length));

  const listOf = <A>(values: readonly A[], fallback: readonly A[]) =>
    next() < 0.2
      ? fallback
      : globalThis.Array.from({ length: Math.floor(next() * 9) }, () =>
          pick(values)
        );

  return {
    maxAgeDays: pick(ageWindows),
    regionGroups: listOf(regionGroups, defaultFilters.regionGroups),
    roles: listOf(roleLevels, defaultFilters.roles),
    search:
      next() < 0.2
        ? ""
        : globalThis.Array.from({ length: Math.floor(next() * 24) }, () =>
            pick(SEARCH_ALPHABET)
          ).join(""),
    sort: pick(["Relevance", "Newest"] as const),
  };
};

describe("board route", () => {
  it("any Filters value round-trips through the board URL unchanged", () => {
    const next = seeded(20_261_017);

    for (let run = 0; run < 2000; run += 1) {
      const filters = filtersFrom(next);

      expect(routeAt(boardUrl(filters)), boardUrl(filters)).toStrictEqual(
        Route.Board({ filters })
      );
    }
  });

  it("the default board is the bare root URL", () => {
    expect(boardUrl(defaultFilters)).toBe("/");
    expect(routeAt("/")).toStrictEqual(
      Route.Board({ filters: defaultFilters })
    );
  });

  it("a filtered board reads as readable slugs", () => {
    expect(
      boardUrl({
        ...defaultFilters,
        regionGroups: ["RemoteCanada"],
        roles: ["Director", "HeadOfEngineering"],
        sort: "Newest",
      })
    ).toBe(
      "/?place=remote-canada&role=director%2Chead-of-engineering&sort=newest"
    );
  });

  it("a malformed query falls back to the default for each bad field", () => {
    expect(
      routeAt("/?age=abc&role=bogus,,&place=%&sort=sideways&utm_source=x")
    ).toStrictEqual(Route.Board({ filters: defaultFilters }));
  });

  it("unknown entries in a list are dropped and known ones kept", () => {
    expect(routeAt("/?role=director,ceo&age=30")).toStrictEqual(
      Route.Board({
        filters: { ...defaultFilters, maxAgeDays: 30, roles: ["Director"] },
      })
    );
  });

  it("an empty list parameter means no selection, not the default", () => {
    expect(routeAt("/?role=")).toStrictEqual(
      Route.Board({ filters: { ...defaultFilters, roles: [] } })
    );
  });
});

describe("job and shortlist routes", () => {
  it.each([
    "ashby:kraken.com:d7e00f01-4b21-4953-8b2f-1ec1bec71a24",
    "hackernews:2026-10:41234567",
    "remoteok:all:engineering-manager/acme 50%",
  ])("job id %s round-trips through /jobs/<id>", (id) => {
    expect(routeAt(jobRouter({ id }))).toStrictEqual(Route.Job({ id }));
  });

  it("keeps colons readable in job URLs", () => {
    expect(jobRouter({ id: "greenhouse:stripe:123" })).toBe(
      "/jobs/greenhouse:stripe:123"
    );
  });

  it("opens the shortlist directly", () => {
    expect(routeAt("/shortlist")).toStrictEqual(Route.Shortlist());
  });

  it.each(["/nope", "/jobs", "/jobs/%E0%A4%A", "/shortlist/extra"])(
    "%s is not found",
    (path) => {
      expect(routeAt(path)._tag).toBe("NotFound");
    }
  );
});
