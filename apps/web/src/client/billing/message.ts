import { Membership, Plan } from "@rat-stack/core/contracts";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

export const Message = defineMessageUnion({
  ClickedChoosePlan: { plan: Plan },
  ClickedManageBilling: {},
  CompletedFetchMembership: { membership: Schema.Option(Membership) },
  CompletedRedirect: {},
  CompletedSetInstantAlerts: { membership: Membership },
  FailedBillingAction: { message: Schema.String },
  ToggledInstantAlerts: { enabled: Schema.Boolean },
});

export type MessageValue = typeof Message.Type;
