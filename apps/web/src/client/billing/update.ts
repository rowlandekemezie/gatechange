import { isPro } from "@rat-stack/core/contracts";
import type { MembershipValue } from "@rat-stack/core/contracts";
import { Option, Schema } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { JobQueries } from "../board/queries.js";
import {
  FetchMembership,
  FetchPlans,
  OpenBillingPortal,
  PollMembership,
  SetInstantAlerts,
  StartCheckout,
} from "./command.js";
import { Message } from "./message.js";
import type { MessageValue } from "./message.js";
import { BillingAction, MembershipState, PlansState } from "./model.js";
import type { BillingActionValue, ModelValue } from "./model.js";

type UpdateReturn = Update.Return<ModelValue, MessageValue, JobQueries>;

export const CHECKOUT_POLLS = 15;

const initial: ModelValue = {
  action: BillingAction.Idle(),
  generation: 0,
  membership: MembershipState.Unknown(),
  plans: PlansState.Loading(),
  pollsLeft: 0,
};

export const init = (): UpdateReturn => ({
  commands: [FetchPlans()],
  model: initial,
});

export const signedIn = (model: ModelValue): UpdateReturn =>
  Schema.is(MembershipState.Unknown)(model.membership)
    ? {
        commands: [FetchMembership({ generation: model.generation })],
        model: modifyFields(model, {
          membership: () => MembershipState.Loading(),
        }),
      }
    : { model };

export const signedOut = (model: ModelValue): ModelValue => ({
  ...initial,
  generation: model.generation + 1,
  plans: model.plans,
});

const isAtRest = (action: BillingActionValue) =>
  Schema.is(BillingAction.Idle)(action) ||
  Schema.is(BillingAction.Problem)(action);

export const entered = (
  model: ModelValue,
  {
    afterCheckout,
    isSignedIn,
  }: { readonly afterCheckout: boolean; readonly isSignedIn: boolean }
): UpdateReturn => ({
  commands: isSignedIn
    ? [FetchMembership({ generation: model.generation })]
    : [],
  model: modifyFields(model, {
    action: (action) => (isAtRest(action) ? BillingAction.Idle() : action),
    pollsLeft: () => (afterCheckout ? CHECKOUT_POLLS : 0),
  }),
});

const fetched = (
  model: ModelValue,
  found: Option.Option<MembershipValue>
): UpdateReturn =>
  Option.match(found, {
    onNone: () => ({
      model: modifyFields(model, {
        membership: (state) =>
          Schema.is(MembershipState.Loaded)(state)
            ? state
            : MembershipState.Failed(),
        pollsLeft: () => 0,
      }),
    }),
    onSome: (membership) => {
      const keepWaiting = model.pollsLeft > 0 && !isPro(membership.entitlement);

      return {
        commands: keepWaiting
          ? [PollMembership({ generation: model.generation })]
          : [],
        model: modifyFields(model, {
          membership: () => MembershipState.Loaded({ membership }),
          pollsLeft: (left) => (keepWaiting ? left - 1 : 0),
        }),
      };
    },
  });

export const update = (
  model: ModelValue,
  message: MessageValue
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedChoosePlan: ({ plan }) =>
      isAtRest(model.action)
        ? {
            commands: [StartCheckout({ plan })],
            model: modifyFields(model, {
              action: () => BillingAction.Redirecting(),
            }),
          }
        : { model },
    ClickedManageBilling: () =>
      Schema.is(BillingAction.Redirecting)(model.action)
        ? { model }
        : {
            commands: [OpenBillingPortal()],
            model: modifyFields(model, {
              action: () => BillingAction.Redirecting(),
            }),
          },
    CompletedFetchMembership: ({ generation, membership }) =>
      generation === model.generation ? fetched(model, membership) : { model },
    CompletedFetchPlans: ({ plans }) => ({
      model: modifyFields(model, { plans: () => PlansState.Loaded({ plans }) }),
    }),
    CompletedRedirect: () => ({ model }),
    CompletedSetInstantAlerts: ({ membership }) => ({
      model: modifyFields(model, {
        action: () => BillingAction.Idle(),
        membership: () => MembershipState.Loaded({ membership }),
      }),
    }),
    FailedBillingAction: ({ message: problem }) => ({
      model: modifyFields(model, {
        action: () => BillingAction.Problem({ message: problem }),
      }),
    }),
    ToggledInstantAlerts: ({ enabled }) =>
      Schema.is(BillingAction.Saving)(model.action)
        ? { model }
        : {
            commands: [SetInstantAlerts({ enabled })],
            model: modifyFields(model, {
              action: () => BillingAction.Saving(),
            }),
          },
  });
