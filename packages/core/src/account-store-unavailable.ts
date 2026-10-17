import { Schema } from "effect";

export class AccountStoreUnavailable extends Schema.TaggedError<AccountStoreUnavailable>()(
  "AccountStoreUnavailable",
  { message: Schema.String }
) {}
