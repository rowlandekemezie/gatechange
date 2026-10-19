import { Schema } from "effect";

export class NoBillingAccount extends Schema.TaggedError<NoBillingAccount>()(
  "NoBillingAccount",
  {}
) {}
