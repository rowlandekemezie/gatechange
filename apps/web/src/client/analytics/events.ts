import { AccountId, Plan } from "@rat-stack/core/contracts";
import { Match, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import type { MessageValue as AccountMessageValue } from "../account/message.js";
import { SessionState, SignInState } from "../account/model.js";
import type { SessionStateValue } from "../account/model.js";
import type { MessageValue as AgentTokensMessageValue } from "../agent-tokens/message.js";
import type { MessageValue as BillingMessageValue } from "../billing/message.js";
import { defaultFilters, hasNoSelection } from "../board/filters.js";
import type { FiltersValue } from "../board/filters.js";
import type { MessageValue } from "../board/message.js";
import { JobsState, JobState, ListingState } from "../board/model.js";
import type { ModelValue } from "../board/model.js";
import { Route } from "../route.js";
import type { RouteValue } from "../route.js";
import type { MessageValue as SavedSearchesMessageValue } from "../saved-searches/message.js";

export const FilterName = Schema.Literals([
  "age",
  "currency",
  "pay_floor",
  "region",
  "reset",
  "role",
  "salary_listed",
  "seniority",
  "sort",
]);

export type FilterNameValue = typeof FilterName.Type;

export const ApplySource = Schema.Literals(["board_row", "job_page"]);

export const ListingKind = Schema.Literals(["company", "role"]);

export type Properties = Readonly<Record<string, boolean | number | string>>;

export const AnalyticsEvent = defineTaggedUnion({
  AgentTokenCreated: {},
  AgentTokenRevoked: {},
  AgentsSectionViewed: {},
  ApplyClicked: { source: ApplySource },
  CheckoutStarted: { plan: Plan },
  FilterChanged: { filter: FilterName },
  InstantAlertsChanged: { enabled: Schema.Boolean },
  JobApplied: {},
  JobNotFound: {},
  JobOpened: {},
  JobSaved: {},
  ListingNotFound: { kind: ListingKind },
  PageViewed: { route: Schema.String },
  PricingViewed: {},
  ReadRateLimited: {},
  SavedSearchCreated: {},
  SearchNoResults: {
    emptySelection: Schema.Boolean,
    filterCount: Schema.Finite,
    queryLength: Schema.Finite,
  },
  SearchSubmitted: { queryLength: Schema.Finite },
  ShowMore: {},
  SigninCompleted: {},
  SignupStarted: { method: Schema.String },
});

export type AnalyticsEventValue = typeof AnalyticsEvent.Type;

export const eventNames: Readonly<Record<AnalyticsEventValue["_tag"], string>> =
  {
    AgentTokenCreated: "agent_token_created",
    AgentTokenRevoked: "agent_token_revoked",
    AgentsSectionViewed: "agents_section_viewed",
    ApplyClicked: "apply_clicked",
    CheckoutStarted: "checkout_started",
    FilterChanged: "filter_changed",
    InstantAlertsChanged: "instant_alerts_changed",
    JobApplied: "job_applied",
    JobNotFound: "job_not_found",
    JobOpened: "job_opened",
    JobSaved: "job_saved",
    ListingNotFound: "listing_not_found",
    PageViewed: "$pageview",
    PricingViewed: "pricing_viewed",
    ReadRateLimited: "read_rate_limited",
    SavedSearchCreated: "saved_search_created",
    SearchNoResults: "search_no_results",
    SearchSubmitted: "search_submitted",
    ShowMore: "show_more",
    SigninCompleted: "signin_completed",
    SignupStarted: "signup_started",
  };

export const propertiesOf = ({
  _tag,
  ...properties
}: AnalyticsEventValue): Properties =>
  Object.fromEntries(
    Object.entries(properties).map(([name, value]) => [
      name.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
      value,
    ])
  );

export const AnalyticsCall = defineTaggedUnion({
  Anonymous: {},
  Identify: { userId: AccountId },
  Reset: {},
  Track: { event: AnalyticsEvent },
});

export type AnalyticsCallValue = typeof AnalyticsCall.Type;

const track = (event: AnalyticsEventValue) => AnalyticsCall.Track({ event });

const FILTERS: Partial<Record<MessageValue["_tag"], FilterNameValue>> = {
  ChangedAge: "age",
  ChangedPayCurrency: "currency",
  ChangedPayFloor: "pay_floor",
  ChangedSort: "sort",
  ClickedAnySeniority: "seniority",
  ClickedResetFilters: "reset",
  ToggledRegionGroup: "region",
  ToggledRole: "role",
  ToggledSalaryListed: "salary_listed",
  ToggledSeniority: "seniority",
};

const none = (): readonly AnalyticsEventValue[] => [];

const accountEvents = Match.type<AccountMessageValue>().pipe(
  Match.tags({
    ClickedSocialSignIn: ({ provider }) => [
      AnalyticsEvent.SignupStarted({ method: provider }),
    ],
    SubmittedSignIn: () => [AnalyticsEvent.SignupStarted({ method: "email" })],
  }),
  Match.orElse(none)
);

const billingEvents = Match.type<BillingMessageValue>().pipe(
  Match.tags({
    ClickedChoosePlan: ({ plan }) => [AnalyticsEvent.CheckoutStarted({ plan })],
    CompletedSetInstantAlerts: ({ membership }) => [
      AnalyticsEvent.InstantAlertsChanged({
        enabled: membership.instantAlerts,
      }),
    ],
  }),
  Match.orElse(none)
);

const savedSearchEvents = Match.type<SavedSearchesMessageValue>().pipe(
  Match.tags({
    CompletedSaveSearch: ({ outcome }) =>
      outcome === "Saved" ? [AnalyticsEvent.SavedSearchCreated()] : [],
  }),
  Match.orElse(none)
);

const agentTokenEvents = Match.type<AgentTokensMessageValue>().pipe(
  Match.tags({
    CompletedIssueToken: () => [AnalyticsEvent.AgentTokenCreated()],
    CompletedRevokeToken: ({ ok }) =>
      ok ? [AnalyticsEvent.AgentTokenRevoked()] : [],
  }),
  Match.orElse(none)
);

const messageEvents = (
  message: MessageValue,
  before: ModelValue
): readonly AnalyticsEventValue[] => {
  const filter = FILTERS[message._tag];

  if (filter !== undefined) {
    return [AnalyticsEvent.FilterChanged({ filter })];
  }

  return Match.value(message).pipe(
    Match.tags({
      ChangedStage: ({ stage }) =>
        stage === "Applied" ? [AnalyticsEvent.JobApplied()] : [],
      ClickedLoadMore: () => [AnalyticsEvent.ShowMore()],
      ClickedMark: ({ kind }) => [
        kind === "Saved"
          ? AnalyticsEvent.JobSaved()
          : AnalyticsEvent.JobApplied(),
      ],
      GotAccountMessage: ({ message: inner }) =>
        Schema.is(SignInState.Editing)(before.account.signIn)
          ? accountEvents(inner)
          : [],
      GotAgentTokensMessage: ({ message: inner }) => agentTokenEvents(inner),
      GotBillingMessage: ({ message: inner }) => billingEvents(inner),
      GotSavedSearchesMessage: ({ message: inner }) => savedSearchEvents(inner),
      SubmittedSearch: () => [
        AnalyticsEvent.SearchSubmitted({
          queryLength: before.draftSearch.trim().length,
        }),
      ],
    }),
    Match.orElse(none)
  );
};

const pageOf = (route: RouteValue) =>
  Schema.is(Route.Board)(route) ? route._tag : JSON.stringify(route);

const routeEvents = (route: RouteValue): readonly AnalyticsEventValue[] => [
  AnalyticsEvent.PageViewed({ route: route._tag }),
  ...(Schema.is(Route.Job)(route) ? [AnalyticsEvent.JobOpened()] : []),
  ...(Schema.is(Route.Pricing)(route) ? [AnalyticsEvent.PricingViewed()] : []),
];

const NARROWING_FILTERS = [
  "maxAgeDays",
  "regionGroups",
  "roles",
  "salaryFloor",
  "salaryListed",
  "seniorities",
] as const satisfies readonly (keyof FiltersValue)[];

const filterCountOf = (filters: FiltersValue) =>
  NARROWING_FILTERS.filter(
    (name) =>
      JSON.stringify(filters[name]) !== JSON.stringify(defaultFilters[name])
  ).length;

const emptyBoardEvents = ({
  filters,
  jobs,
  route,
}: ModelValue): readonly AnalyticsEventValue[] =>
  Schema.is(Route.Board)(route) &&
  Schema.is(JobsState.Loaded)(jobs) &&
  jobs.total === 0
    ? [
        AnalyticsEvent.SearchNoResults({
          emptySelection: hasNoSelection(filters),
          filterCount: filterCountOf(filters),
          queryLength: filters.search.trim().length,
        }),
      ]
    : [];

const missingJobEvents = ({
  job,
}: ModelValue): readonly AnalyticsEventValue[] =>
  Schema.is(JobState.Missing)(job) ? [AnalyticsEvent.JobNotFound()] : [];

const emptyListingEvents = ({
  listing,
}: ModelValue): readonly AnalyticsEventValue[] =>
  Schema.is(ListingState.Loaded)(listing) && listing.total === 0
    ? [
        AnalyticsEvent.ListingNotFound({
          kind: Schema.is(Route.Company)(listing.route) ? "company" : "role",
        }),
      ]
    : [];

const outcomeEvents = (
  before: ModelValue | undefined,
  after: ModelValue
): readonly AnalyticsEventValue[] => [
  ...(before?.jobs === after.jobs ? [] : emptyBoardEvents(after)),
  ...(before?.job === after.job ? [] : missingJobEvents(after)),
  ...(before?.listing === after.listing ? [] : emptyListingEvents(after)),
];

const isSignedIn = Schema.is(SessionState.SignedIn);

const isChecking = Schema.is(SessionState.Checking);

const sessionCalls = (
  before: SessionStateValue,
  after: ModelValue
): readonly AnalyticsCallValue[] => {
  const { session } = after.account;

  if (isSignedIn(session) && !isSignedIn(before)) {
    const completed =
      Schema.is(SessionState.SignedOut)(before) ||
      Schema.is(Route.ConfirmSignIn)(after.route);

    return [
      AnalyticsCall.Identify({ userId: session.account.id }),
      ...(completed ? [track(AnalyticsEvent.SigninCompleted())] : []),
    ];
  }

  if (isSignedIn(before) && !isSignedIn(session)) {
    return [AnalyticsCall.Reset()];
  }

  return isChecking(before) && !isChecking(session)
    ? [AnalyticsCall.Anonymous()]
    : [];
};

export const callsOf = (
  message: MessageValue,
  before: ModelValue,
  after: ModelValue
): readonly AnalyticsCallValue[] => [
  ...(pageOf(before.route) === pageOf(after.route)
    ? []
    : routeEvents(after.route).map(track)),
  ...messageEvents(message, before).map(track),
  ...outcomeEvents(before, after).map(track),
  ...sessionCalls(before.account.session, after),
];

export const landingCallsOf = (model: ModelValue) =>
  [...routeEvents(model.route), ...outcomeEvents(undefined, model)].map(track);
