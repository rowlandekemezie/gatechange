// @effect-diagnostics asyncFunction:off -- The fetch stub has the Promise-based signature fetch requires.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test compares definitions with the server event source on disk.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import {
  dashboards,
  HEALTH_EVENTS,
  MANAGED_TAG,
  SITE_SCOPE,
} from "../../../scripts/posthog-dashboard-definitions.ts";
import type {
  DashboardSpec,
  InsightSpec,
} from "../../../scripts/posthog-dashboard-definitions.ts";
import { planOf, Step } from "../../../scripts/posthog-dashboard-plan.ts";
import type { Snapshot } from "../../../scripts/posthog-dashboard-plan.ts";
import {
  describePlan,
  modeOf,
  run,
  settingsOf,
} from "../../../scripts/posthog-dashboards.ts";
import { CAMPAIGN_PARAMS } from "../src/client/analytics/client.js";
import {
  AnalyticsEvent,
  eventNames,
  propertiesOf,
} from "../src/client/analytics/events.js";

const KEY = "phx_secret_personal_key";

const SETTINGS = settingsOf({
  POSTHOG_PERSONAL_API_KEY: KEY,
  POSTHOG_PROJECT_ID: "42",
});

const INSIGHTS = dashboards.flatMap((board) => board.insights);

const [FIRST_BOARD] = dashboards;

const [FIRST_INSIGHT] = INSIGHTS;

if (FIRST_BOARD === undefined || FIRST_INSIGHT === undefined) {
  throw new Error("definitions are empty");
}

const BOARD: DashboardSpec = FIRST_BOARD;

const INSIGHT: InsightSpec = FIRST_INSIGHT;

interface SeededRow {
  readonly fields: Schema.JsonObject;
  readonly id: number;
  readonly removedTiles?: readonly number[];
  readonly tiles?: readonly number[];
}

interface Call {
  readonly authorization: string | null;
  readonly body: Schema.JsonObject;
  readonly method: string;
  readonly url: string;
}

const decodeBody = Schema.decodeUnknownSync(Schema.JsonObject);

const fetchLayer = (stub: typeof globalThis.fetch) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, stub))
  );

const storeOf = (rows: readonly SeededRow[]) =>
  new Map(rows.map((row) => [row.id, row]));

const versionStamped = (node: Schema.Json): Schema.Json => {
  if (Array.isArray(node)) {
    return node.map(versionStamped);
  }

  if (node instanceof Object) {
    const entries = Object.entries(node).map(
      ([key, value]) => [key, versionStamped(value)] as const
    );

    return Object.fromEntries(
      "kind" in node ? [...entries, ["version", 4] as const] : entries
    );
  }

  return node;
};

const merged = (...parts: readonly Schema.JsonObject[]): Schema.JsonObject =>
  Object.fromEntries(parts.flatMap((part) => Object.entries(part)));

const fakePostHog = (seed: {
  readonly dashboards?: readonly SeededRow[];
  readonly insights?: readonly SeededRow[];
}) => {
  const calls: Call[] = [];
  const boards = storeOf(seed.dashboards ?? []);
  const insights = storeOf(seed.insights ?? []);
  const counter = { next: 1000 };

  const wire = ({ fields, id, removedTiles = [], tiles = [] }: SeededRow) =>
    merged(fields, {
      dashboard_tiles: [
        ...tiles.map((dashboard_id) => ({ dashboard_id })),
        ...removedTiles.map((dashboard_id) => ({
          dashboard_id,
          deleted: true,
        })),
      ],
      id,
      query: versionStamped(fields.query ?? null),
    });

  const create = (rows: Map<number, SeededRow>, fields: Schema.JsonObject) => {
    counter.next += 1;

    const row = { fields, id: counter.next };

    rows.set(row.id, row);

    return Response.json(wire(row), { status: 201 });
  };

  const patch = (
    rows: Map<number, SeededRow>,
    id: number,
    fields: Schema.JsonObject
  ) => {
    const row = rows.get(id);

    if (row === undefined) {
      return Response.json({}, { status: 404 });
    }

    const next = { ...row, fields: merged(row.fields, fields) };

    rows.set(id, next);

    return Response.json(wire(next));
  };

  const list = (rows: Map<number, SeededRow>, url: URL) => {
    const all = [...rows.values()];
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 100);

    return Response.json({
      count: all.length,
      next: offset + limit < all.length ? "https://elsewhere.example/" : null,
      results: all.slice(offset, offset + limit).map(wire),
    });
  };

  const attach = (dashboardId: number, insightId: Schema.Json | undefined) => {
    const row = insights.get(Number(insightId));

    if (row === undefined || !boards.has(dashboardId)) {
      return Response.json({}, { status: 404 });
    }

    insights.set(row.id, {
      ...row,
      tiles: [...(row.tiles ?? []), dashboardId],
    });

    return Response.json({ dashboard_id: dashboardId, id: 1 });
  };

  const respond = ({ body, method, url: address }: Call) => {
    const url = new URL(address);
    const [collection, id, action] = url.pathname.split("/").slice(4);
    const rows = collection === "dashboards" ? boards : insights;

    if (action === "add_insight") {
      return attach(Number(id), body.insight_id);
    }

    if (method === "GET") {
      return list(rows, url);
    }

    return method === "POST"
      ? create(rows, body)
      : patch(rows, Number(id), body);
  };

  const stub: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();

    const call = {
      authorization: request.headers.get("authorization"),
      body: text === "" ? {} : decodeBody(JSON.parse(text)),
      method: request.method,
      url: request.url,
    };

    calls.push(call);

    return respond(call);
  };

  return {
    calls,
    insights,
    layer: fetchLayer(stub),
    writes: () => calls.filter(({ method }) => method !== "GET"),
  };
};

const answering =
  (status: number): typeof globalThis.fetch =>
  async () =>
    await Promise.resolve(Response.json({ detail: "nope" }, { status }));

const droppingTags: typeof globalThis.fetch = async (input, init) =>
  await Promise.resolve(
    new Request(input, init).method === "GET"
      ? Response.json({ count: 0, next: null, results: [] })
      : Response.json({ id: 1, tags: [] }, { status: 201 })
  );

const insightNamed = (name: string) => {
  const insight = INSIGHTS.find((candidate) => candidate.name === name);

  if (insight === undefined) {
    throw new Error(`no insight named ${name}`);
  }

  return insight;
};

const queryNamed = (name: string) => insightNamed(name).query;

const EMPTY: Snapshot = { dashboards: [], insights: [] };

const ONE_BOARD: readonly DashboardSpec[] = [BOARD];

const managedBoard = (id: number): SeededRow => ({
  fields: {
    description: BOARD.description,
    name: BOARD.name,
    tags: [MANAGED_TAG],
  },
  id,
});

const reversedKeys = (query: Schema.Json) =>
  Schema.decodeUnknownSync(Schema.Json)(
    JSON.parse(JSON.stringify(query), (_key: string, value: Schema.Json) =>
      value instanceof Object && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).toReversed())
        : value
    )
  );

describe("posthog dashboard definitions", () => {
  it("defines the six boards in order", () => {
    expect(dashboards.map(({ name }) => name)).toStrictEqual([
      "Gate Change: Launch",
      "Gate Change: Job seeker funnel",
      "Gate Change: Retention",
      "Gate Change: Revenue",
      "Gate Change: Agents",
      "Gate Change: Health",
    ]);
  });

  it("gives every insight a unique name and a description", () => {
    expect(new Set(INSIGHTS.map(({ name }) => name)).size).toBe(
      INSIGHTS.length
    );
    expect(INSIGHTS.every(({ description }) => description !== "")).toBe(true);
  });

  it("keeps descriptions within PostHog's 400 character limit", () => {
    expect(
      INSIGHTS.filter(({ description }) => description.length > 400)
    ).toStrictEqual([]);
  });

  it("scopes to the https site, keeps server events, drops test and automated traffic", () => {
    expect(SITE_SCOPE).toBe(
      "NOT startsWith(distinct_id, 'audit-')" +
        " AND distinct_id NOT IN ('audit-probe', 'audit-probe-user', 'probe_posthog_503')" +
        " AND event != 'gc_proxy_probe'" +
        " AND NOT endsWith(distinct_id, '-772e-84d9-91a3b005d5fc')" +
        " AND (startsWith(properties.$current_url, 'https://gatechange.dev/') OR properties.$lib = 'jobs-api')"
    );
  });

  it("applies the shared scope to every query", () => {
    for (const { name, query } of INSIGHTS) {
      expect(JSON.stringify(query), name).toContain(SITE_SCOPE);
    }
  });

  it("names only events that the web and API sources emit", () => {
    const api = readFileSync(
      new URL("../../api/src/analytics.ts", import.meta.url),
      "utf-8"
    );

    const guessed = new Set(
      HEALTH_EVENTS.filter(({ confirmed }) => !confirmed).map(
        ({ event }) => event
      )
    );

    const web = new Set([...Object.values(eventNames), "$identify"]);

    const unknown = INSIGHTS.flatMap(({ events }) => events).filter(
      (event) =>
        !web.has(event) &&
        !api.includes(`event: "${event}"`) &&
        !guessed.has(event)
    );

    expect(unknown).toStrictEqual([]);
  });

  it("orders the job seeker funnel with search or filter as one step", () => {
    expect(queryNamed("Job seekers: Funnel")).toMatchObject({
      kind: "InsightVizNode",
      source: {
        kind: "FunnelsQuery",
        series: [
          { event: "$pageview", kind: "EventsNode" },
          {
            kind: "GroupNode",
            nodes: [{ event: "search_submitted" }, { event: "filter_changed" }],
            operator: "OR",
          },
          { event: "job_opened", kind: "EventsNode" },
          { event: "apply_clicked", kind: "EventsNode" },
        ],
      },
    });
  });

  it("orders the revenue funnel through the server activation", () => {
    expect(insightNamed("Revenue: Funnel").events).toStrictEqual([
      "pricing_viewed",
      "checkout_started",
      "subscription_activated",
    ]);
  });

  it("breaks down by the property names the client and API send", () => {
    const [source] = Object.keys(
      propertiesOf(AnalyticsEvent.ApplyClicked({ source: "job_page" }))
    );

    const [filter] = Object.keys(
      propertiesOf(AnalyticsEvent.FilterChanged({ filter: "role" }))
    );

    expect(queryNamed("Job seekers: Apply clicks by source")).toMatchObject({
      source: { breakdownFilter: { breakdown: source } },
    });
    expect(queryNamed("Job seekers: Filter changes by filter")).toMatchObject({
      source: { breakdownFilter: { breakdown: filter } },
    });
    expect(queryNamed("Agents: MCP tool calls by tool")).toMatchObject({
      source: { breakdownFilter: { breakdown: "tool" } },
    });
  });

  it("counts digests delivered, not cron runs", () => {
    expect(queryNamed("Retention: Digests sent")).toMatchObject({
      source: {
        series: [{ event: "digest_sent", math: "sum", math_property: "count" }],
      },
    });
  });

  it("measures returning users on $identify, since anonymous ids last one page load", () => {
    expect(queryNamed("Retention: Returning signed-in users")).toMatchObject({
      source: {
        kind: "RetentionQuery",
        retentionFilter: {
          returningEntity: { id: "$identify" },
          targetEntity: { id: "$identify" },
        },
      },
    });
  });

  it("selects every campaign param the client records", () => {
    const text = JSON.stringify(queryNamed("Launch: Campaign traffic"));

    for (const param of CAMPAIGN_PARAMS) {
      expect(text).toContain(`properties.${param} AS ${param}`);
    }
  });

  it("marks unconfirmed Health rows so an empty chart cannot read as healthy", () => {
    const unconfirmed = HEALTH_EVENTS.filter(({ confirmed }) => !confirmed);

    for (const { title } of unconfirmed) {
      expect(insightNamed(`Health: ${title}`).description).toContain(
        "not confirmed"
      );
    }
  });

  it("gives every Health row its own insight", () => {
    const health = dashboards.find(({ name }) => name.endsWith("Health"));

    expect(health?.insights.flatMap(({ events }) => events)).toStrictEqual(
      HEALTH_EVENTS.map(({ event }) => event)
    );
  });
});

const insightRow = (
  id: number,
  name: string | null,
  tags: readonly string[]
) => ({
  dashboardIds: [],
  description: INSIGHT.description,
  id,
  name,
  query: INSIGHT.query,
  tags,
});

const planRename = (insights: Snapshot["insights"]) =>
  planOf(
    [
      {
        ...BOARD,
        insights: [{ ...INSIGHT, formerName: "Old name", name: "New name" }],
      },
    ],
    { dashboards: [], insights }
  );

describe("posthog dashboard plan", () => {
  it("creates everything on an empty project and attaches each insight", () => {
    const { boards, conflicts } = planOf(ONE_BOARD, EMPTY);
    const [board] = boards;

    expect(board?.step).toStrictEqual(Step.Create({ name: BOARD.name }));
    expect(
      board?.insights.every(
        ({ attach, step }) => attach && Step.$is("Create")(step)
      )
    ).toBe(true);
    expect(conflicts).toStrictEqual([]);
  });

  it("refuses a same-named dashboard without the managed tag", () => {
    const { conflicts } = planOf(ONE_BOARD, {
      dashboards: [
        { description: "", id: 7, name: BOARD.name, tags: ["starter"] },
      ],
      insights: [],
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain(MANAGED_TAG);
  });

  it("refuses two managed objects with one name instead of picking one", () => {
    const row = { description: "", name: BOARD.name, tags: [MANAGED_TAG] };

    const { conflicts } = planOf(ONE_BOARD, {
      dashboards: [
        { ...row, id: 7 },
        { ...row, id: 8 },
      ],
      insights: [],
    });

    expect(conflicts).toHaveLength(1);
  });

  it("prefers the managed row when an unmanaged row shares its name", () => {
    const row = { description: BOARD.description, name: BOARD.name };

    const { boards, conflicts } = planOf(ONE_BOARD, {
      dashboards: [
        { ...row, id: 7, tags: [] },
        { ...row, id: 8, tags: [MANAGED_TAG] },
      ],
      insights: [],
    });

    expect(conflicts).toStrictEqual([]);
    expect(boards[0]?.step).toStrictEqual(Step.Keep({ id: 8 }));
  });

  it("renames an insight in place instead of adding a second tile", () => {
    const renamed = { ...INSIGHT, formerName: "Old name", name: "New name" };

    const { boards } = planOf([{ ...BOARD, insights: [renamed] }], {
      dashboards: [
        {
          description: BOARD.description,
          id: 7,
          name: BOARD.name,
          tags: [MANAGED_TAG],
        },
      ],
      insights: [
        {
          dashboardIds: [7],
          description: INSIGHT.description,
          id: 9,
          name: "Old name",
          query: INSIGHT.query,
          tags: [MANAGED_TAG],
        },
      ],
    });

    expect(boards[0]?.insights[0]?.step).toStrictEqual(Step.Update({ id: 9 }));
    expect(boards[0]?.insights[0]?.attach).toBe(false);
  });

  it("refuses an unmanaged insight under the former name and names it", () => {
    const { boards, conflicts } = planRename([
      insightRow(9, "Old name", ["starter"]),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('"Old name"');
    expect(conflicts[0]).not.toContain('"New name"');
    expect(boards[0]?.insights[0]?.attach).toBe(false);
  });

  it("refuses when both names are managed and names both", () => {
    const { boards, conflicts } = planRename([
      insightRow(9, "Old name", [MANAGED_TAG]),
      insightRow(10, "New name", [MANAGED_TAG]),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('"Old name"');
    expect(conflicts[0]).toContain('"New name"');
    expect(boards[0]?.insights[0]?.attach).toBe(false);
  });

  it("does not take a null-named row for a spec with no former name", () => {
    const { description, events, name, query } = INSIGHT;

    const { boards, conflicts } = planOf(
      [{ ...BOARD, insights: [{ description, events, name, query }] }],
      { dashboards: [], insights: [insightRow(9, null, [MANAGED_TAG])] }
    );

    expect(conflicts).toStrictEqual([]);
    expect(boards[0]?.insights[0]?.step).toStrictEqual(Step.Create({ name }));
  });

  it("ignores the version PostHog stamps on stored queries", () => {
    const { boards } = planOf(ONE_BOARD, {
      dashboards: [
        {
          description: BOARD.description,
          id: 7,
          name: BOARD.name,
          tags: [MANAGED_TAG],
        },
      ],
      insights: [
        {
          dashboardIds: [7],
          description: INSIGHT.description,
          id: 9,
          name: INSIGHT.name,
          query: versionStamped(INSIGHT.query),
          tags: [MANAGED_TAG],
        },
      ],
    });

    expect(boards[0]?.insights[0]?.step).toStrictEqual(Step.Keep({ id: 9 }));
  });

  it("ignores key order when it compares a stored query", () => {
    const { boards } = planOf(ONE_BOARD, {
      dashboards: [
        {
          description: BOARD.description,
          id: 7,
          name: BOARD.name,
          tags: [MANAGED_TAG],
        },
      ],
      insights: [
        {
          dashboardIds: [7],
          description: INSIGHT.description,
          id: 9,
          name: INSIGHT.name,
          query: reversedKeys(INSIGHT.query),
          tags: [MANAGED_TAG],
        },
      ],
    });

    expect(boards[0]?.insights[0]?.step).toStrictEqual(Step.Keep({ id: 9 }));
    expect(boards[0]?.insights[0]?.attach).toBe(false);
  });
});

describe("posthog dashboard runner", () => {
  it.effect("writes nothing on a dry run", () => {
    const posthog = fakePostHog({});

    return Effect.gen(function* dryRun() {
      const plan = yield* run("dry-run", SETTINGS);

      expect(posthog.writes()).toStrictEqual([]);
      expect(posthog.calls.length).toBeGreaterThan(0);
      expect(describePlan(plan)).toContain(
        'create dashboard "Gate Change: Launch"'
      );
    }).pipe(Effect.provide(posthog.layer));
  });

  it.effect("makes no request on a dry run without credentials", () => {
    const posthog = fakePostHog({});

    return Effect.gen(function* offline() {
      const plan = yield* run("dry-run", settingsOf({}));

      expect(posthog.calls).toStrictEqual([]);
      expect(plan.boards).toHaveLength(dashboards.length);
    }).pipe(Effect.provide(posthog.layer));
  });

  it.effect("stops an apply without credentials and names the variable", () =>
    Effect.gen(function* missing() {
      const failure = yield* Effect.flip(run("apply", settingsOf({})));

      expect(failure.message).toContain("POSTHOG_PERSONAL_API_KEY");
    }).pipe(Effect.provide(fakePostHog({}).layer))
  );

  it.effect("sends the key as a bearer token to the project path", () => {
    const posthog = fakePostHog({});

    return Effect.gen(function* bearer() {
      yield* run("dry-run", SETTINGS);

      expect(
        new Set(posthog.calls.map(({ authorization }) => authorization))
      ).toStrictEqual(new Set([`Bearer ${KEY}`]));
      expect(posthog.calls[0]?.url).toContain(
        "https://eu.posthog.com/api/projects/42/dashboards/"
      );
    }).pipe(Effect.provide(posthog.layer));
  });

  it.effect("creates, tags and attaches on the first apply", () => {
    const posthog = fakePostHog({});

    return Effect.gen(function* firstApply() {
      yield* run("apply", SETTINGS);

      const writes = posthog.writes();
      const creates = writes.filter(({ url }) => !url.includes("add_insight"));
      const attaches = writes.filter(({ url }) => url.includes("add_insight"));

      expect(creates).toHaveLength(dashboards.length + INSIGHTS.length);
      expect(attaches).toHaveLength(INSIGHTS.length);
      expect(
        creates.every(({ body }) =>
          JSON.stringify(body.tags).includes(MANAGED_TAG)
        )
      ).toBe(true);
      expect(writes.some(({ body }) => "dashboards" in body)).toBe(false);
    }).pipe(Effect.provide(posthog.layer));
  });

  it.effect("writes nothing on a second apply", () => {
    const posthog = fakePostHog({});

    return Effect.gen(function* secondApply() {
      yield* run("apply", SETTINGS);

      const writes = posthog.writes().length;

      const plan = yield* run("apply", SETTINGS);

      expect(posthog.writes()).toHaveLength(writes);
      expect(
        describePlan(plan).filter((line) =>
          /^\s*(?:create|update|attach|conflict)/u.test(line)
        )
      ).toStrictEqual([]);
    }).pipe(Effect.provide(posthog.layer));
  });

  it.effect("finishes the attachment a crashed run left undone", () => {
    const posthog = fakePostHog({
      dashboards: [managedBoard(7)],
      insights: [
        {
          fields: {
            description: INSIGHT.description,
            name: INSIGHT.name,
            query: INSIGHT.query,
            tags: [MANAGED_TAG],
          },
          id: 9,
        },
      ],
    });

    return Effect.gen(function* crashed() {
      yield* run("apply", SETTINGS);

      const attach = posthog
        .writes()
        .find(({ url }) => url.includes("/dashboards/7/add_insight/"));

      expect(attach?.body).toStrictEqual({ insight_id: 9 });
      expect(
        posthog.writes().filter(({ url }) => url.endsWith("/insights/"))
      ).toHaveLength(INSIGHTS.length - 1);
    }).pipe(Effect.provide(posthog.layer));
  });

  it.effect("restores a tile someone removed from the dashboard", () => {
    const posthog = fakePostHog({
      dashboards: [managedBoard(7)],
      insights: [
        {
          fields: {
            description: INSIGHT.description,
            name: INSIGHT.name,
            query: INSIGHT.query,
            tags: [MANAGED_TAG],
          },
          id: 9,
          removedTiles: [7],
        },
      ],
    });

    return Effect.gen(function* removed() {
      yield* run("apply", SETTINGS);

      expect(
        posthog
          .writes()
          .some(({ url }) => url.includes("/dashboards/7/add_insight/"))
      ).toBe(true);
    }).pipe(Effect.provide(posthog.layer));
  });

  it.effect("patches only what changed and keeps other tags and tiles", () => {
    const posthog = fakePostHog({
      dashboards: [managedBoard(7)],
      insights: [
        {
          fields: {
            description: INSIGHT.description,
            name: INSIGHT.name,
            query: { kind: "Stale" },
            tags: [MANAGED_TAG, "someone-elses"],
          },
          id: 9,
          tiles: [7, 99],
        },
      ],
    });

    return Effect.gen(function* changed() {
      yield* run("apply", SETTINGS);

      const patch = posthog.writes().find(({ method }) => method === "PATCH");

      expect(patch?.url).toContain("/insights/9/");
      expect(Object.keys(patch?.body ?? {}).toSorted()).toStrictEqual([
        "description",
        "name",
        "query",
      ]);
      expect(posthog.insights.get(9)?.tiles).toStrictEqual([7, 99]);
    }).pipe(Effect.provide(posthog.layer));
  });

  it.effect(
    "refuses the whole apply when the last board has a conflict",
    () => {
      const last = dashboards.at(-1)?.name ?? "";

      const posthog = fakePostHog({
        dashboards: [
          {
            fields: { description: "starter", name: last, tags: [] },
            id: 7,
          },
        ],
      });

      return Effect.gen(function* refused() {
        const failure = yield* Effect.flip(run("apply", SETTINGS));

        expect(failure.message).toContain(last);
        expect(posthog.writes()).toStrictEqual([]);
      }).pipe(Effect.provide(posthog.layer));
    }
  );

  it.effect("reads every page without following the server's next link", () => {
    const posthog = fakePostHog({
      insights: Array.from({ length: 250 }, (_, index) => ({
        fields: { description: "", name: `other ${index}`, tags: [] },
        id: index + 1,
      })),
    });

    return Effect.gen(function* paged() {
      yield* run("dry-run", SETTINGS);

      const pages = posthog.calls.filter(({ url }) =>
        url.includes("/insights/")
      );

      expect(pages).toHaveLength(3);
      expect(pages.every(({ url }) => !url.includes("elsewhere"))).toBe(true);
    }).pipe(Effect.provide(posthog.layer));
  });

  it.effect("stops when PostHog drops the managed tag on create", () =>
    Effect.gen(function* tagDropped() {
      const failure = yield* Effect.flip(run("apply", SETTINGS));

      expect(failure.message).toContain(MANAGED_TAG);
    }).pipe(Effect.provide(fetchLayer(droppingTags)))
  );

  it.effect.each([401, 403])(
    "names the scopes on %i without the key",
    (status) =>
      Effect.gen(function* refused() {
        const { message } = yield* Effect.flip(run("dry-run", SETTINGS));

        for (const scope of [
          "dashboard:read",
          "dashboard:write",
          "insight:read",
          "insight:write",
        ]) {
          expect(message).toContain(scope);
        }

        expect(message).toContain(String(status));
        expect(message).not.toContain(KEY);
        expect(message.includes("nope")).toBe(status === 403);
      }).pipe(Effect.provide(fetchLayer(answering(status))))
  );

  it.effect("reports a server failure without the key", () =>
    Effect.gen(function* serverFailure() {
      const { message } = yield* Effect.flip(run("dry-run", SETTINGS));

      expect(message).toContain("500");
      expect(message).not.toContain(KEY);
    }).pipe(Effect.provide(fetchLayer(answering(500))))
  );
});

describe("posthog dashboard settings", () => {
  it("defaults the host and redacts the key", () => {
    expect(SETTINGS.host).toBe("https://eu.posthog.com");
    expect(JSON.stringify(SETTINGS)).not.toContain(KEY);
    expect(SETTINGS.key && Redacted.value(SETTINGS.key)).toBe(KEY);
  });

  it("trims a trailing slash from the host", () => {
    expect(settingsOf({ POSTHOG_HOST: "https://us.posthog.com/" }).host).toBe(
      "https://us.posthog.com"
    );
  });

  it.effect("selects apply only on the exact flag and refuses a typo", () =>
    Effect.gen(function* modes() {
      expect(yield* modeOf([])).toBe("dry-run");
      expect(yield* modeOf(["--"])).toBe("dry-run");
      expect(yield* modeOf(["--apply"])).toBe("apply");

      const { message } = yield* Effect.flip(modeOf(["--aply"]));

      expect(message).toContain("--aply");
    })
  );

  it.effect("refuses a host that would carry the key in clear text", () => {
    const posthog = fakePostHog({});

    return Effect.gen(function* insecure() {
      const { message } = yield* Effect.flip(
        run(
          "dry-run",
          settingsOf({
            POSTHOG_HOST: "http://eu.posthog.com",
            POSTHOG_PERSONAL_API_KEY: KEY,
            POSTHOG_PROJECT_ID: "42",
          })
        )
      );

      expect(message).toContain("POSTHOG_HOST");
      expect(posthog.calls).toStrictEqual([]);
    }).pipe(Effect.provide(posthog.layer));
  });

  it.effect("refuses a project id that is not a number", () => {
    const posthog = fakePostHog({});

    return Effect.gen(function* badProject() {
      const { message } = yield* Effect.flip(
        run(
          "dry-run",
          settingsOf({
            POSTHOG_PERSONAL_API_KEY: KEY,
            POSTHOG_PROJECT_ID: "42/../7",
          })
        )
      );

      expect(message).toContain("POSTHOG_PROJECT_ID");
      expect(posthog.calls).toStrictEqual([]);
    }).pipe(Effect.provide(posthog.layer));
  });
});
