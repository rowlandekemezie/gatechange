import { Console, Data, Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import {
  dashboards,
  HEALTH_EVENTS,
  MANAGED_TAG,
} from "./posthog-dashboard-definitions.ts";
import type {
  DashboardSpec,
  InsightSpec,
} from "./posthog-dashboard-definitions.ts";
import { planOf, Step } from "./posthog-dashboard-plan.ts";
import type {
  InsightPlan,
  Plan,
  RemoteDashboard,
  RemoteInsight,
  StepValue,
} from "./posthog-dashboard-plan.ts";

const DEFAULT_HOST = "https://eu.posthog.com";

const REQUIRED_SCOPES =
  "dashboard:read, dashboard:write, insight:read, insight:write";

const PAGE_SIZE = 100;

const REQUEST_TIMEOUT = "30 seconds";

export class PostHogStop extends Data.TaggedError("PostHogStop")<{
  readonly message: string;
}> {}

export type Mode = "apply" | "dry-run";

export interface Settings {
  readonly host: string;
  readonly key: Redacted.Redacted | undefined;
  readonly project: string | undefined;
}

interface Connection {
  readonly base: string;
  readonly key: Redacted.Redacted;
}

const DashboardRow = Schema.Struct({
  description: Schema.optional(Schema.NullOr(Schema.String)),
  id: Schema.Number,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  tags: Schema.Array(Schema.String),
});

const InsightRow = Schema.Struct({
  ...DashboardRow.fields,
  dashboard_tiles: Schema.optional(
    Schema.Array(
      Schema.Struct({
        dashboard_id: Schema.Number,
        deleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
      })
    )
  ),
  query: Schema.optional(Schema.NullOr(Schema.Json)),
});

const pageOf = <Row extends Schema.Top>(row: Row) =>
  Schema.Struct({
    next: Schema.NullOr(Schema.String),
    results: Schema.Array(row),
  });

const decodeDashboards = Schema.decodeUnknownEffect(pageOf(DashboardRow));

const decodeInsights = Schema.decodeUnknownEffect(pageOf(InsightRow));

const decodeWritten = Schema.decodeUnknownEffect(
  Schema.Struct({
    id: Schema.Number,
    tags: Schema.Array(Schema.String),
  })
);

const decodeTile = Schema.decodeUnknownEffect(
  Schema.Struct({ dashboard_id: Schema.Number })
);

const remoteDashboardOf = ({
  description,
  id,
  name,
  tags,
}: typeof DashboardRow.Type): RemoteDashboard => ({
  description: description ?? "",
  id,
  name: name ?? null,
  tags,
});

const remoteInsightOf = (row: typeof InsightRow.Type): RemoteInsight => ({
  ...remoteDashboardOf(row),
  dashboardIds: (row.dashboard_tiles ?? []).flatMap(
    ({ dashboard_id, deleted }) => (deleted === true ? [] : [dashboard_id])
  ),
  query: row.query ?? null,
});

const stop = (message: string) => new PostHogStop({ message });

const presentIn = (value: string | undefined) =>
  value === undefined || value === "" ? undefined : value;

export const settingsOf = ({
  POSTHOG_HOST,
  POSTHOG_PERSONAL_API_KEY,
  POSTHOG_PROJECT_ID,
}: NodeJS.ProcessEnv): Settings => {
  const key = presentIn(POSTHOG_PERSONAL_API_KEY);

  return {
    host: (presentIn(POSTHOG_HOST) ?? DEFAULT_HOST).replace(/\/+$/u, ""),
    key: key === undefined ? undefined : Redacted.make(key),
    project: presentIn(POSTHOG_PROJECT_ID),
  };
};

export const modeOf = (
  args: readonly string[]
): Effect.Effect<Mode, PostHogStop> => {
  const unknown = args.filter((arg) => arg !== "--" && arg !== "--apply");

  if (unknown.length > 0) {
    return Effect.fail(
      stop(`Unknown argument ${unknown.join(" ")}. The only flag is --apply.`)
    );
  }

  return Effect.succeed(args.includes("--apply") ? "apply" : "dry-run");
};

const connectionOf = (
  mode: Mode,
  { host, key, project }: Settings
): Effect.Effect<Option.Option<Connection>, PostHogStop> => {
  if (key === undefined || project === undefined) {
    return mode === "apply"
      ? Effect.fail(
          stop(
            "--apply needs POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID in the environment."
          )
        )
      : Effect.succeed(Option.none());
  }

  if (!/^\d+$/u.test(project)) {
    return Effect.fail(stop("POSTHOG_PROJECT_ID must be a number."));
  }

  return URL.parse(host)?.protocol === "https:"
    ? Effect.succeed(
        Option.some({ base: `${host}/api/projects/${project}`, key })
      )
    : Effect.fail(stop("POSTHOG_HOST must be an https URL."));
};

const exchange = <Body>(
  { key }: Connection,
  request: HttpClientRequest.HttpClientRequest,
  decode: (json: Schema.Json) => Effect.Effect<Body, Schema.SchemaError>
) =>
  Effect.gen(function* exchangeJson() {
    const client = yield* HttpClient.HttpClient;
    const label = `${request.method} ${URL.parse(request.url)?.pathname}`;

    const failed = ({ message }: { readonly message: string }) =>
      stop(`${label} failed: ${message}`);

    const response = yield* client
      .execute(request.pipe(HttpClientRequest.bearerToken(key)))
      .pipe(Effect.mapError(failed));

    if (response.status === 401) {
      return yield* stop(
        `PostHog answered 401 to ${label}. The personal API key is invalid or POSTHOG_HOST is the wrong region. The key needs these scopes: ${REQUIRED_SCOPES}.`
      );
    }

    if (response.status === 403) {
      const detail = yield* response.text.pipe(Effect.mapError(failed));

      return yield* stop(
        `PostHog answered 403 to ${label}: ${detail.slice(0, 500)} The key needs these scopes on this project: ${REQUIRED_SCOPES}. It also needs edit access to the object.`
      );
    }

    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.mapError(failed));

      return yield* stop(
        `${label} returned ${response.status}: ${text.slice(0, 500)}`
      );
    }

    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
      Effect.flatMap(decode),
      Effect.mapError(failed)
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () =>
        Effect.fail(stop(`${request.url} timed out after ${REQUEST_TIMEOUT}.`)),
    })
  );

const listAll = <Row>(
  connection: Connection,
  path: string,
  decode: (
    json: Schema.Json
  ) => Effect.Effect<
    { readonly next: string | null; readonly results: readonly Row[] },
    Schema.SchemaError
  >
) =>
  Effect.gen(function* readPages() {
    const rows: Row[] = [];

    for (;;) {
      const { next, results } = yield* exchange(
        connection,
        HttpClientRequest.get(`${connection.base}${path}`).pipe(
          HttpClientRequest.setUrlParams({
            basic: "true",
            limit: String(PAGE_SIZE),
            offset: String(rows.length),
          })
        ),
        decode
      );

      rows.push(...results);

      if (next === null || results.length === 0) {
        return rows;
      }
    }
  });

const snapshotOf = (connection: Connection) =>
  Effect.all({
    dashboards: listAll(connection, "/dashboards/", decodeDashboards),
    insights: listAll(connection, "/insights/", decodeInsights),
  }).pipe(
    Effect.map((rows) => ({
      dashboards: rows.dashboards.map(remoteDashboardOf),
      insights: rows.insights.map(remoteInsightOf),
    }))
  );

const created = (
  connection: Connection,
  path: string,
  payload: Schema.JsonObject
) =>
  exchange(
    connection,
    HttpClientRequest.post(`${connection.base}${path}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(payload)
    ),
    decodeWritten
  ).pipe(
    Effect.filterOrFail(
      ({ tags }) => tags.includes(MANAGED_TAG),
      ({ id }) =>
        stop(
          `PostHog created ${path}${id} but dropped the ${MANAGED_TAG} tag. Add the tag in PostHog before the next run, or the script will refuse to touch that object.`
        )
    ),
    Effect.map(({ id }) => id)
  );

const patched = (
  connection: Connection,
  path: string,
  id: number,
  payload: Schema.JsonObject
) =>
  exchange(
    connection,
    HttpClientRequest.patch(`${connection.base}${path}${id}/`).pipe(
      HttpClientRequest.bodyJsonUnsafe(payload)
    ),
    decodeWritten
  ).pipe(Effect.as(id));

const applyDashboard = (
  connection: Connection,
  { description, name }: DashboardSpec,
  step: StepValue
) =>
  Step.$match(step, {
    Conflict: ({ reason }) => Effect.fail(stop(reason)),
    Create: () =>
      created(connection, "/dashboards/", {
        description,
        name,
        tags: [MANAGED_TAG],
      }),
    Keep: ({ id }) => Effect.succeed(id),
    Update: ({ id }) =>
      patched(connection, "/dashboards/", id, { description }),
  });

const applyInsight = (
  connection: Connection,
  { description, name, query }: InsightSpec,
  step: StepValue
) =>
  Step.$match(step, {
    Conflict: ({ reason }) => Effect.fail(stop(reason)),
    Create: () =>
      created(connection, "/insights/", {
        description,
        name,
        query,
        saved: true,
        tags: [MANAGED_TAG],
      }),
    Keep: ({ id }) => Effect.succeed(id),
    Update: ({ id }) =>
      patched(connection, "/insights/", id, { description, query }),
  });

const attachInsight = (
  connection: Connection,
  dashboardId: number,
  insightId: number
) =>
  exchange(
    connection,
    HttpClientRequest.post(
      `${connection.base}/dashboards/${dashboardId}/add_insight/`
    ).pipe(HttpClientRequest.bodyJsonUnsafe({ insight_id: insightId })),
    decodeTile
  );

const applyTile = (
  connection: Connection,
  dashboardId: number,
  { attach, spec, step }: InsightPlan
) =>
  Effect.gen(function* applyOneTile() {
    const insightId = yield* applyInsight(connection, spec, step);

    if (attach) {
      yield* attachInsight(connection, dashboardId, insightId);
    }
  });

const applyPlan = (connection: Connection, plan: Plan) =>
  Effect.forEach(
    plan.boards,
    ({ insights, spec, step }) =>
      applyDashboard(connection, spec, step).pipe(
        Effect.flatMap((dashboardId) =>
          Effect.forEach(
            insights,
            (insight) => applyTile(connection, dashboardId, insight),
            { discard: true }
          )
        )
      ),
    { discard: true }
  );

const verbOf = (step: StepValue) =>
  Step.$match(step, {
    Conflict: ({ reason }) => `conflict (${reason})`,
    Create: () => "create",
    Keep: () => "keep",
    Update: () => "update",
  });

const insightLines = ({ attach, spec, step }: InsightPlan, board: string) => [
  `  ${verbOf(step)} insight "${spec.name}"`,
  ...(attach ? [`  attach "${spec.name}" to "${board}"`] : []),
];

export const describePlan = ({ boards }: Plan) => [
  ...boards.flatMap(({ insights, spec, step }) => [
    `${verbOf(step)} dashboard "${spec.name}"`,
    ...insights.flatMap((insight) => insightLines(insight, spec.name)),
  ]),
  ...HEALTH_EVENTS.filter(({ confirmed }) => !confirmed).map(
    ({ event }) => `guessed Health event name: ${event}`
  ),
];

export const run = (mode: Mode, settings: Settings) =>
  Effect.gen(function* runDashboards() {
    const connection = yield* connectionOf(mode, settings);

    if (Option.isNone(connection)) {
      yield* Console.error(
        "POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID is missing, so nothing was looked up. Every object shows as new."
      );
    }

    const snapshot = yield* Option.match(connection, {
      onNone: () => Effect.succeed({ dashboards: [], insights: [] }),
      onSome: snapshotOf,
    });

    const plan = planOf(dashboards, snapshot);

    yield* Console.log(describePlan(plan).join("\n"));

    if (Option.isSome(connection) && mode === "apply") {
      if (plan.conflicts.length > 0) {
        return yield* stop(plan.conflicts.join("\n"));
      }

      yield* applyPlan(connection.value, plan);
    }

    return plan;
  });

if (import.meta.main) {
  await Effect.runPromise(
    modeOf(process.argv.slice(2)).pipe(
      Effect.flatMap((mode) => run(mode, settingsOf(process.env))),
      Effect.provide(FetchHttpClient.layer),
      Effect.catchTag("PostHogStop", ({ message }) =>
        Console.error(message).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            })
          )
        )
      ),
      Effect.asVoid
    )
  );
}
