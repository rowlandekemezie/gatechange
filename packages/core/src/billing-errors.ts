import { Schema } from "effect";

import { AlreadyPro } from "./already-pro.js";
import { BillingUnavailable } from "./billing-unavailable.js";
import { JobStoreUnavailable } from "./job-store-unavailable.js";
import { NoBillingAccount } from "./no-billing-account.js";
import { ProRequired } from "./pro-required.js";
import { Unauthorized } from "./unauthorized.js";

export const BillingFailure = Schema.Union([
  AlreadyPro,
  BillingUnavailable,
  JobStoreUnavailable,
  NoBillingAccount,
  ProRequired,
  Unauthorized,
]);

export type BillingFailureValue = typeof BillingFailure.Type;
