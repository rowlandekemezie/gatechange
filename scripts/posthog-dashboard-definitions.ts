import type { Schema } from "effect";

export const MANAGED_TAG = "gate-change-managed";

const SITE_HOST = "gatechange.dev";

const SERVER_LIB = "jobs-api";

const TEST_DISTINCT_ID_PREFIX = "audit-";

const TEST_DISTINCT_IDS = [
  "audit-probe",
  "audit-probe-user",
  "probe_posthog_503",
] as const;

const TEST_EVENT = "gc_proxy_probe";

const quoted = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(", ");

export const SITE_SCOPE = [
  `NOT startsWith(distinct_id, '${TEST_DISTINCT_ID_PREFIX}')`,
  `distinct_id NOT IN (${quoted(TEST_DISTINCT_IDS)})`,
  `event != '${TEST_EVENT}'`,
  `(properties.$host = '${SITE_HOST}' OR properties.$lib = '${SERVER_LIB}')`,
].join(" AND ");

const SCOPE_FILTERS = [{ key: SITE_SCOPE, type: "hogql" }];

const CAMPAIGN_PARAMS = [
  "ref",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
] as const;

export type InsightQuery = Schema.Json;

export interface InsightSpec {
  readonly description: string;
  readonly events: readonly string[];
  readonly name: string;
  readonly query: InsightQuery;
}

export interface DashboardSpec {
  readonly description: string;
  readonly insights: readonly InsightSpec[];
  readonly name: string;
}

export interface HealthEvent {
  readonly confirmed: boolean;
  readonly description: string;
  readonly event: string;
  readonly title: string;
}

export const HEALTH_EVENTS: readonly HealthEvent[] = [
  {
    confirmed: true,
    description: "Searches saved by signed-in users.",
    event: "saved_search_created",
    title: "Saved searches",
  },
  {
    confirmed: true,
    description: "Instant alerts turned on or off.",
    event: "instant_alerts_changed",
    title: "Instant alerts",
  },
  {
    confirmed: true,
    description: "Agent tokens issued.",
    event: "agent_token_created",
    title: "Agent tokens issued",
  },
  {
    confirmed: true,
    description: "Agent tokens revoked.",
    event: "agent_token_revoked",
    title: "Agent tokens revoked",
  },
  {
    confirmed: true,
    description: "Boards that settled on no roles.",
    event: "search_no_results",
    title: "Zero results",
  },
  {
    confirmed: true,
    description: "Job pages that settled as missing.",
    event: "job_not_found",
    title: "Missing job pages",
  },
  {
    confirmed: true,
    description: "Company or role pages with no jobs.",
    event: "listing_not_found",
    title: "Empty listing pages",
  },
  {
    confirmed: true,
    description: "Email unsubscribes.",
    event: "email_unsubscribed",
    title: "Unsubscribes",
  },
  {
    confirmed: true,
    description: "Reads refused by the rate limit, once per request.",
    event: "read_rate_limited",
    title: "Rate-limited reads",
  },
];

const LAST_30_DAYS = { date_from: "-30d" };

const step = (event: string) => ({ event, kind: "EventsNode", name: event });

const total = (event: string) => ({ ...step(event), math: "total" });

const uniqueUsers = (event: string) => ({ ...step(event), math: "dau" });

const summed = (event: string, property: string) => ({
  ...step(event),
  math: "sum",
  math_property: property,
});

type Series = ReturnType<typeof step>;

const scoped = {
  dateRange: LAST_30_DAYS,
  filterTestAccounts: false,
  properties: SCOPE_FILTERS,
};

const viz = (source: InsightQuery) => ({ kind: "InsightVizNode", source });

const trendOf = (series: Series) => ({
  events: [series.event],
  query: viz({
    ...scoped,
    interval: "day",
    kind: "TrendsQuery",
    series: [series],
    trendsFilter: { display: "ActionsLineGraph" },
  }),
});

const breakdownOf = (series: Series, property: string) => ({
  events: [series.event],
  query: viz({
    ...scoped,
    breakdownFilter: {
      breakdown: property,
      breakdown_limit: 25,
      breakdown_type: "event",
    },
    interval: "day",
    kind: "TrendsQuery",
    series: [series],
    trendsFilter: { display: "ActionsBarValue" },
  }),
});

const funnelOf = (
  events: readonly string[],
  series: readonly InsightQuery[]
) => ({
  events,
  query: viz({
    ...scoped,
    funnelsFilter: { funnelOrderType: "ordered", funnelVizType: "steps" },
    kind: "FunnelsQuery",
    series,
  }),
});

const weeklyRetentionOf = (event: string) => {
  const entity = { id: event, kind: "EventsNode", name: event, type: "events" };

  return {
    events: [event],
    query: viz({
      filterTestAccounts: false,
      kind: "RetentionQuery",
      properties: SCOPE_FILTERS,
      retentionFilter: {
        period: "Week",
        retentionType: "retention_recurring",
        returningEntity: entity,
        targetEntity: entity,
        totalIntervals: 8,
      },
    }),
  };
};

const campaignTraffic = () => {
  const columns = CAMPAIGN_PARAMS.map(
    (param) => `properties.${param} AS ${param}`
  );

  const present = CAMPAIGN_PARAMS.map((param) => `properties.${param}`);

  return {
    events: ["$pageview"],
    query: {
      display: "ActionsTable",
      kind: "DataVisualizationNode",
      source: {
        kind: "HogQLQuery",
        query: [
          `SELECT ${columns.join(", ")}, uniq(properties.$session_id) AS visits`,
          "FROM events",
          `WHERE event = '$pageview' AND timestamp >= now() - INTERVAL 30 DAY AND ${SITE_SCOPE} AND coalesce(${present.join(", ")}) IS NOT NULL`,
          `GROUP BY ${CAMPAIGN_PARAMS.join(", ")}`,
          "ORDER BY visits DESC",
          "LIMIT 100",
        ].join(" "),
      },
    },
  };
};

const SEARCH_OR_FILTER = ["search_submitted", "filter_changed"];

const JOB_SEEKER_FUNNEL = funnelOf(
  ["$pageview", ...SEARCH_OR_FILTER, "job_opened", "apply_clicked"],
  [
    step("$pageview"),
    {
      custom_name: "Searched or filtered",
      kind: "GroupNode",
      name: "Searched or filtered",
      nodes: SEARCH_OR_FILTER.map(step),
      operator: "OR",
    },
    step("job_opened"),
    step("apply_clicked"),
  ]
);

const REVENUE_EVENTS = [
  "pricing_viewed",
  "checkout_started",
  "subscription_activated",
];

export const dashboards: readonly DashboardSpec[] = [
  {
    description: "Traffic, sources and accounts since launch.",
    insights: [
      {
        ...trendOf(uniqueUsers("$pageview")),
        description:
          "Unique visitors per day. Anonymous ids last one page load, so a repeat visitor counts again.",
        name: "Launch: Visitors per day",
      },
      {
        ...breakdownOf(total("$pageview"), "$pathname"),
        description: "Pageviews for the 25 busiest paths.",
        name: "Launch: Pageviews by path",
      },
      {
        ...breakdownOf(uniqueUsers("$pageview"), "$referring_domain"),
        description: "Unique visitors by referring domain.",
        name: "Launch: Visitors by referring domain",
      },
      {
        ...campaignTraffic(),
        description: "Visits in the last 30 days with a ref or utm parameter.",
        name: "Launch: Campaign traffic",
      },
      {
        ...breakdownOf(total("signup_started"), "method"),
        description:
          "Sign-in forms and social buttons used, by method. This counts attempts, not finished accounts.",
        name: "Launch: Sign-ups started by method",
      },
      {
        ...trendOf(total("signin_completed")),
        description: "Completed sign-ins per day.",
        name: "Launch: Sign-ins completed",
      },
    ],
    name: "Gate Change: Launch",
  },
  {
    description: "From first pageview to an apply click.",
    insights: [
      {
        ...JOB_SEEKER_FUNNEL,
        description:
          "Pageview, then search or filter, then job opened, then apply clicked.",
        name: "Job seekers: Funnel",
      },
      {
        ...breakdownOf(total("apply_clicked"), "source"),
        description: "Apply clicks by board row or job page.",
        name: "Job seekers: Apply clicks by source",
      },
      {
        ...breakdownOf(total("filter_changed"), "filter"),
        description: "Filter changes by filter name.",
        name: "Job seekers: Filter changes by filter",
      },
    ],
    name: "Gate Change: Job seeker funnel",
  },
  {
    description: "Whether signed-in people come back and keep using the board.",
    insights: [
      {
        ...weeklyRetentionOf("$identify"),
        description:
          "Weekly return rate of signed-in users. $identify fires once per signed-in page load; anonymous ids reset on every load, so anonymous people cannot be retained.",
        name: "Retention: Returning signed-in users",
      },
      {
        ...trendOf(total("job_saved")),
        description: "Jobs saved per day.",
        name: "Retention: Jobs saved",
      },
      {
        ...trendOf(total("job_applied")),
        description: "Jobs marked as applied per day.",
        name: "Retention: Jobs applied",
      },
      {
        ...trendOf(summed("digest_sent", "count")),
        description: "Digest emails delivered per day, summed from each run.",
        name: "Retention: Digests sent",
      },
    ],
    name: "Gate Change: Retention",
  },
  {
    description: "From the pricing page to a paid subscription.",
    insights: [
      {
        ...funnelOf(REVENUE_EVENTS, REVENUE_EVENTS.map(step)),
        description: "Pricing viewed, then checkout started, then activated.",
        name: "Revenue: Funnel",
      },
    ],
    name: "Gate Change: Revenue",
  },
  {
    description: "Interest in the agent surface and what agents call.",
    insights: [
      {
        ...trendOf(uniqueUsers("agents_section_viewed")),
        description: "Unique visitors who saw the agents section.",
        name: "Agents: Section views",
      },
      {
        ...breakdownOf(total("mcp_tool_called"), "tool"),
        description:
          "MCP tool calls by tool. Server events share one distinct id, so this counts calls, not agents.",
        name: "Agents: MCP tool calls by tool",
      },
    ],
    name: "Gate Change: Agents",
  },
  {
    description: "Product signals that something needs attention.",
    insights: HEALTH_EVENTS.map(({ confirmed, description, event, title }) => ({
      ...trendOf(total(event)),
      description: confirmed
        ? description
        : `${description} Event name not confirmed, so an empty chart proves nothing.`,
      name: `Health: ${title}`,
    })),
    name: "Gate Change: Health",
  },
];
