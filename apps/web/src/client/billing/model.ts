import { isPro, Membership } from "@rat-stack/core/contracts";
import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

export const MembershipState = defineTaggedUnion({
  Failed: {},
  Loaded: { membership: Membership },
  Loading: {},
  Unknown: {},
});

export type MembershipStateValue = typeof MembershipState.Type;

export const BillingAction = defineTaggedUnion({
  Idle: {},
  Problem: { message: Schema.String },
  Redirecting: {},
  Saving: {},
});

export type BillingActionValue = typeof BillingAction.Type;

export const Model = Schema.Struct({
  action: BillingAction,
  membership: MembershipState,
  pollsLeft: Schema.Finite,
});

export type ModelValue = typeof Model.Type;

export const isProMember = (model: ModelValue) =>
  Schema.is(MembershipState.Loaded)(model.membership) &&
  isPro(model.membership.membership.entitlement);
