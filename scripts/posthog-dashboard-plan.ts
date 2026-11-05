// @effect-diagnostics nodeBuiltinImport:off -- Stored queries are compared with Node's structural equality, which ignores key order.
import { isDeepStrictEqual } from "node:util";

import { Data } from "effect";

import { MANAGED_TAG } from "./posthog-dashboard-definitions.ts";
import type {
  DashboardSpec,
  InsightQuery,
  InsightSpec,
} from "./posthog-dashboard-definitions.ts";

export interface RemoteDashboard {
  readonly description: string;
  readonly id: number;
  readonly name: string | null;
  readonly tags: readonly string[];
}

export interface RemoteInsight extends RemoteDashboard {
  readonly dashboardIds: readonly number[];
  readonly query: InsightQuery;
}

export interface Snapshot {
  readonly dashboards: readonly RemoteDashboard[];
  readonly insights: readonly RemoteInsight[];
}

export type StepValue = Data.TaggedEnum<{
  Conflict: { readonly reason: string };
  Create: { readonly name: string };
  Keep: { readonly id: number };
  Update: { readonly id: number };
}>;

export const Step = Data.taggedEnum<StepValue>();

export interface InsightPlan {
  readonly attach: boolean;
  readonly spec: InsightSpec;
  readonly step: StepValue;
}

export interface BoardPlan {
  readonly insights: readonly InsightPlan[];
  readonly spec: DashboardSpec;
  readonly step: StepValue;
}

export interface Plan {
  readonly boards: readonly BoardPlan[];
  readonly conflicts: readonly string[];
}

const withoutVersions = (query: InsightQuery): InsightQuery => {
  if (Array.isArray(query)) {
    return query.map(withoutVersions);
  }

  return query instanceof Object
    ? Object.fromEntries(
        Object.entries(query).flatMap(([key, value]) =>
          key === "version" ? [] : [[key, withoutVersions(value)]]
        )
      )
    : query;
};

const resolve = <Row extends RemoteDashboard>(
  name: string,
  label: string,
  rows: readonly Row[],
  isCurrent: (row: Row) => boolean
) => {
  const managed = rows.filter(({ tags }) => tags.includes(MANAGED_TAG));
  const [row] = managed;

  if (managed.length > 1) {
    return {
      row: undefined,
      step: Step.Conflict({
        reason: `${managed.length} ${label} rows carry ${MANAGED_TAG}. Delete the extras in PostHog.`,
      }),
    };
  }

  if (row === undefined) {
    return {
      row,
      step:
        rows.length > 0
          ? Step.Conflict({
              reason: `${label} already exists without ${MANAGED_TAG}, so it was left alone. Rename it or add the tag in PostHog.`,
            })
          : Step.Create({ name }),
    };
  }

  return {
    row,
    step: isCurrent(row)
      ? Step.Keep({ id: row.id })
      : Step.Update({ id: row.id }),
  };
};

const planInsight = (
  spec: InsightSpec,
  boardId: number | undefined,
  insights: readonly RemoteInsight[]
): InsightPlan => {
  const { row, step } = resolve(
    spec.name,
    `Insight "${spec.name}"`,
    insights.filter(({ name }) => name === spec.name),
    ({ description, query }) =>
      description === spec.description &&
      isDeepStrictEqual(withoutVersions(query), spec.query)
  );

  return {
    attach:
      !Step.$is("Conflict")(step) &&
      (boardId === undefined || row?.dashboardIds.includes(boardId) !== true),
    spec,
    step,
  };
};

const planBoard = (spec: DashboardSpec, snapshot: Snapshot): BoardPlan => {
  const { row, step } = resolve(
    spec.name,
    `Dashboard "${spec.name}"`,
    snapshot.dashboards.filter(({ name }) => name === spec.name),
    ({ description }) => description === spec.description
  );

  return {
    insights: spec.insights.map((insight) =>
      planInsight(insight, row?.id, snapshot.insights)
    ),
    spec,
    step,
  };
};

const reasonOf = (step: StepValue) =>
  Step.$is("Conflict")(step) ? [step.reason] : [];

export const planOf = (
  specs: readonly DashboardSpec[],
  snapshot: Snapshot
): Plan => {
  const boards = specs.map((spec) => planBoard(spec, snapshot));

  return {
    boards,
    conflicts: boards.flatMap(({ insights, step }) => [
      ...reasonOf(step),
      ...insights.flatMap((insight) => reasonOf(insight.step)),
    ]),
  };
};
