import { Context } from "effect";
import type { Effect } from "effect";

import type { ArrangementValue, JobValue, SalaryBandValue } from "./job.js";
import type { PostingGone } from "./posting-gone.js";
import type { PostingUnavailable } from "./posting-unavailable.js";

export interface PostingTextValue {
  readonly salary: SalaryBandValue | null;
  readonly text: string;
  readonly workplace: ArrangementValue;
}

export class PostingTexts extends Context.Service<
  PostingTexts,
  {
    readonly fetch: (
      job: JobValue
    ) => Effect.Effect<PostingTextValue, PostingGone | PostingUnavailable>;
  }
>()("@rat-stack/core/PostingTexts") {}
