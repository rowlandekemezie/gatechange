import { Schema } from "effect";

import { CompanySummary } from "./company-intel.js";
import { JobPage, JobDetail } from "./job.js";

export const COMPANY_LISTING_ROWS = 12;

export const CompanyJobs = Schema.Struct({
  ...JobPage.fields,
  jobs: Schema.Array(JobDetail).check(Schema.isMaxLength(COMPANY_LISTING_ROWS)),
  summary: CompanySummary,
});

export type CompanyJobsValue = typeof CompanyJobs.Type;
