import { describe, expect, it } from "@effect/vitest";
import {
  companySlugOf,
  JobQuery,
  RoleLevel,
  roleLevels,
  seniorities,
} from "@rat-stack/core/contracts";
import type { RoleLevelValue } from "@rat-stack/core/contracts";
import { Option, Schema } from "effect";
import { fromString } from "foldkit/url";

import {
  defaultFilters,
  Filters,
  inOrderOf,
  queryOf,
  RegionGroup,
  regionGroups,
  toggled,
} from "../src/client/board/filters.js";
import type { FiltersValue } from "../src/client/board/filters.js";
import {
  boardUrl,
  companyRouter,
  jobRouter,
  roleRouter,
  Route,
  routeOfUrl,
} from "../src/client/route.js";

const ORIGIN = "https://jobs.example";

const routeAt = (path: string) =>
  routeOfUrl(Option.getOrThrow(fromString(`${ORIGIN}${path}`)));

const LONE_SURROGATE = /\p{Cs}/gu;

const routeFilters = (path: string): FiltersValue => {
  const route = routeAt(path);

  if (!Schema.is(Route.Board)(route)) {
    throw new Error(`${path} is not a board URL`);
  }

  return route.filters;
};

const toggledBy = (clicks: readonly RoleLevelValue[]) => {
  let roles: readonly RoleLevelValue[] = [];

  for (const role of clicks) {
    roles = toggled(roleLevels, roles, role);
  }

  return roles;
};

describe("board route", () => {
  it.prop(
    "any Filters value round-trips through the board URL as its canonical form",
    { filters: Filters },
    ({ filters }) => {
      const canonical = {
        ...filters,
        regionGroups: inOrderOf(regionGroups, filters.regionGroups),
        roles: inOrderOf(roleLevels, filters.roles),
        search: filters.search.replaceAll(LONE_SURROGATE, "\uFFFD"),
        seniorities: inOrderOf(seniorities, filters.seniorities),
      };

      expect(routeAt(boardUrl(filters)), boardUrl(filters)).toStrictEqual(
        Route.Board({ filters: canonical })
      );
      expect(boardUrl(routeFilters(boardUrl(filters)))).toBe(
        boardUrl(canonical)
      );
    },
    { arbitrary: { runs: 2000 } }
  );

  it.prop(
    "toggling builds the same list whatever order the clicks came in",
    { clicks: Schema.Array(RoleLevel) },
    ({ clicks }) => {
      const forward = toggledBy(clicks);

      expect(forward).toStrictEqual(toggledBy(clicks.toReversed()));
      expect(forward).toStrictEqual(inOrderOf(roleLevels, forward));
    }
  );

  it("a duplicated or reordered list parses to one canonical list", () => {
    expect(
      routeAt(
        "/?role=director,vice-president,director&place=british-columbia,remote-canada"
      )
    ).toStrictEqual(
      Route.Board({
        filters: {
          ...defaultFilters,
          regionGroups: ["RemoteCanada", "BritishColumbia"],
          roles: ["VicePresident", "Director"],
        },
      })
    );
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
        roles: ["HeadOfEngineering", "Director"],
        sort: "Newest",
      })
    ).toBe(
      "/?place=remote-canada&role=head-of-engineering%2Cdirector&sort=newest"
    );
  });

  it("a pay floor and levels read as readable slugs", () => {
    const filters: FiltersValue = {
      ...defaultFilters,
      salaryFloor: { amount: 200_000, currency: "CAD" },
      seniorities: ["Manager", "SeniorDirector"],
    };

    expect(boardUrl(filters)).toBe(
      "/?currency=cad&level=manager%2Csenior-director&pay=200000"
    );
    expect(routeAt(boardUrl(filters))).toStrictEqual(Route.Board({ filters }));
  });

  it("a US dollar floor leaves the currency out of the URL", () => {
    expect(
      boardUrl({
        ...defaultFilters,
        salaryFloor: { amount: 150_000, currency: "USD" },
      })
    ).toBe("/?pay=150000");
  });

  it("a currency or level without a usable pay floor falls back to no restriction", () => {
    expect(routeAt("/?currency=cad&pay=123456&level=ceo,")).toStrictEqual(
      Route.Board({ filters: defaultFilters })
    );
    expect(routeAt("/?pay=300000&currency=yen")).toStrictEqual(
      Route.Board({
        filters: {
          ...defaultFilters,
          salaryFloor: { amount: 300_000, currency: "USD" },
        },
      })
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

describe("board query", () => {
  it("the default filters ask for no pay floor and no level restriction", () => {
    expect(queryOf(defaultFilters, 0)).toStrictEqual({
      limit: 40,
      maxAgeDays: 7,
      offset: 0,
      regions: [
        "RemoteCanada",
        "RemoteNorthAmerica",
        "RemoteGlobal",
        "RemoteUnitedStates",
        "BritishColumbia",
      ],
      roles: defaultFilters.roles,
      salaryFloor: null,
      salaryListed: false,
      search: "",
      seniorities: [],
      sort: "Relevance",
    });
  });

  it.prop(
    "any Filters value maps to a JobQuery the contract accepts, carrying its pay floor and levels",
    { filters: Filters },
    ({ filters }) => {
      const query = queryOf(filters, 0);

      expect(Schema.is(JobQuery)(query)).toBe(true);
      expect(query.salaryFloor).toStrictEqual(filters.salaryFloor);
      expect(query.seniorities).toStrictEqual(filters.seniorities);
    }
  );
});

const decodePath = (pathname: string) =>
  pathname
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/")
    .replaceAll(/\/+/gu, "/");

const encodePath = (pathname: string) =>
  pathname
    .split("/")
    .map((segment) => {
      try {
        return encodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");

const isServedWithoutRedirect = (path: string) => {
  const { pathname } = new URL(`${ORIGIN}${path}`);

  return encodePath(decodePath(pathname)) === pathname;
};

const HIMALAYAS_GUID =
  "https://himalayas.app/companies/moniepoint/jobs/engineering-manager-9245044553";

const SOURCE_IDS = [
  "ashby:kraken.com:d7e00f01-4b21-4953-8b2f-1ec1bec71a24",
  "greenhouse:stripe:7023114",
  "lever:netflix:0b6e1c7a-3e2f-4d5b-9a8c-1f2e3d4c5b6a",
  "hackernews:2026-10:41234567",
  `himalayas:${HIMALAYAS_GUID}`,
  `himalayas:engineering-manager:${HIMALAYAS_GUID}`,
  "himalayas:director:https://himalayas.app/companies/a%20b/jobs/x?y=1#z",
  "jobicy:engineering:118042",
  "remoteok:all:1093512",
  "remotive:engineering-manager:2037741",
  "remoteok:all:engineering-manager/acme 50%",
  "a:b",
  "colons::and:::more",
  "percent %2F %25 %",
  "spaces  and\ttabs",
  "dots/../and/./slashes//",
  "unicode é 漢 🚀",
  "+=?#&",
];

const ID_ALPHABET = [
  "a",
  "Z",
  "0",
  "9",
  ":",
  "/",
  "%",
  "?",
  "#",
  "&",
  "=",
  "+",
  " ",
  ".",
  "_",
  "-",
  "~",
  "é",
  "漢",
  "🚀",
  "\\",
] as const;

describe("job and shortlist routes", () => {
  it.each(SOURCE_IDS)("job id %s round-trips through /jobs/<id>", (id) => {
    expect(routeAt(jobRouter({ id }))).toStrictEqual(Route.Job({ id }));
  });

  it.each(SOURCE_IDS)(
    "the asset server serves /jobs/<%s> without a normalizing redirect",
    (id) => {
      expect(isServedWithoutRedirect(jobRouter({ id }))).toBe(true);
    }
  );

  it.prop(
    "any job id built from URL-hostile characters gets a path the asset server leaves alone and that parses back",
    { parts: Schema.NonEmptyArray(Schema.Literals(ID_ALPHABET)) },
    ({ parts }) => {
      const id = parts.join("");
      const path = jobRouter({ id });

      expect(isServedWithoutRedirect(path), path).toBe(true);
      expect(routeAt(path), path).toStrictEqual(Route.Job({ id }));
    },
    { arbitrary: { runs: 2000 } }
  );

  it.prop(
    "any well-formed job id round-trips through /jobs/<id> without a redirect",
    {
      id: Schema.NonEmptyString.check(
        Schema.makeFilter((id) => !/\p{Cs}/u.test(id))
      ),
    },
    ({ id }) => {
      const path = jobRouter({ id });

      expect(isServedWithoutRedirect(path), path).toBe(true);
      expect(routeAt(path), path).toStrictEqual(Route.Job({ id }));
    },
    { arbitrary: { runs: 2000 } }
  );

  it("the percent-encoded form a Himalayas id used to take is what the asset server rewrites", () => {
    expect(
      isServedWithoutRedirect(
        `/jobs/${encodeURIComponent(`himalayas:${HIMALAYAS_GUID}`)}`
      )
    ).toBe(false);
  });

  it("builds job URLs as unpadded base64url", () => {
    expect(jobRouter({ id: "greenhouse:stripe:123" })).toBe(
      "/jobs/Z3JlZW5ob3VzZTpzdHJpcGU6MTIz"
    );
  });

  it("opens the shortlist directly", () => {
    expect(routeAt("/shortlist")).toStrictEqual(Route.Shortlist());
  });

  it.each([
    "/nope",
    "/jobs",
    "/jobs/greenhouse:stripe:123",
    "/jobs/Z3JlZW5ob3VzZTpzdHJpcGU6MTIz%3D",
    "/jobs/Z3JlZW5ob3VzZTpzdHJpcGU6MTIz==",
    "/jobs/YWJ",
    "/jobs/Z3JlZW5ob3VzZTpzdHJpcGU6MT",
    "/jobs/_w",
    "/jobs/%E0%A4%A",
    "/jobs/a.b",
    "/shortlist/extra",
  ])("%s is not found", (path) => {
    expect(routeAt(path)._tag).toBe("NotFound");
  });
});

describe("company and role routes", () => {
  it("a company slug keeps only lowercase ASCII words of the name", () => {
    expect(companySlugOf("Acme, Inc.")).toStrictEqual(Option.some("acme-inc"));
    expect(companySlugOf("  Zeta & Sons ")).toStrictEqual(
      Option.some("zeta-sons")
    );
    expect(companySlugOf("漢字")).toStrictEqual(Option.none());
  });

  it.prop(
    "any company name with a slug opens its company page",
    { company: Schema.String },
    ({ company }) => {
      for (const slug of Option.toArray(companySlugOf(company))) {
        expect(routeAt(companyRouter({ slug }))).toStrictEqual(
          Route.Company({ slug })
        );
      }
    }
  );

  it.prop(
    "every role and place round-trips through its role page URL",
    { place: RegionGroup, role: RoleLevel },
    ({ place, role }) => {
      expect(routeAt(roleRouter({ place, role }))).toStrictEqual(
        Route.Role({ place, role })
      );
    }
  );

  it("role pages read as readable slugs", () => {
    expect(roleRouter({ place: "RemoteCanada", role: "Director" })).toBe(
      "/roles/director/remote-canada"
    );
  });

  it.each([
    "/companies",
    "/companies/Acme",
    "/companies/acme--inc",
    "/companies/-acme",
    "/roles/director",
    "/roles/Director/remote-canada",
    "/roles/director/remoteCanada",
    "/roles/director/remote-canada/extra",
  ])("%s is not found", (path) => {
    expect(routeAt(path)._tag).toBe("NotFound");
  });
});
