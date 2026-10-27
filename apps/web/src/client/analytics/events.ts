import { AccountId, Plan } from "@rat-stack/core/contracts";
import { Match, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import type { MessageValue as AccountMessageValue } from "../account/message.js";
import { SessionState } from "../account/model.js";
import type { SessionStateValue } from "../account/model.js";
import type { MessageValue as BillingMessageValue } from "../billing/message.js";
import type { MessageValue } from "../board/message.js";
import type { ModelValue } from "../board/model.js";
import { Route } from "../route.js";
import type { RouteValue } from "../route.js";

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

export type Properties = Readonly<Record<string, boolean | number | string>>;

export const AnalyticsEvent = defineTaggedUnion({
  AgentsSectionViewed: {},
  ApplyClicked: { source: ApplySource },
  CheckoutStarted: { plan: Plan },
  FilterChanged: { filter: FilterName },
  JobApplied: {},
  JobOpened: {},
  JobSaved: {},
  PageViewed: { route: Schema.String },
  PricingViewed: {},
  SearchSubmitted: { queryLength: Schema.Finite },
  ShowMore: {},
  SigninCompleted: {},
  SignupStarted: { method: Schema.String },
});

export type AnalyticsEventValue = typeof AnalyticsEvent.Type;

export const eventNames: Readonly<Record<AnalyticsEventValue["_tag"], string>> =
  {
    AgentsSectionViewed: "agents_section_viewed",
    ApplyClicked: "apply_clicked",
    CheckoutStarted: "checkout_started",
    FilterChanged: "filter_changed",
    JobApplied: "job_applied",
    JobOpened: "job_opened",
    JobSaved: "job_saved",
    PageViewed: "$pageview",
    PricingViewed: "pricing_viewed",
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
      GotAccountMessage: ({ message: inner }) => accountEvents(inner),
      GotBillingMessage: ({ message: inner }) => billingEvents(inner),
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

const isSignedIn = Schema.is(SessionState.SignedIn);

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

  return isSignedIn(before) && !isSignedIn(session)
    ? [AnalyticsCall.Reset()]
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
  ...sessionCalls(before.account.session, after),
];

export const landingCallsOf = (model: ModelValue) =>
  routeEvents(model.route).map(track);
