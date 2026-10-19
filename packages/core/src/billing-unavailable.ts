import { Schema } from "effect";

export class BillingUnavailable extends Schema.TaggedError<BillingUnavailable>()(
  "BillingUnavailable",
  { message: Schema.String }
) {}
