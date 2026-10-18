import { Context } from "effect";
import type { Effect } from "effect";

import type { JobValue } from "./job.js";
import type { PostingGone } from "./posting-gone.js";
import type { PostingUnavailable } from "./posting-unavailable.js";

export class PostingTexts extends Context.Service<
  PostingTexts,
  {
    readonly fetch: (
      job: JobValue
    ) => Effect.Effect<string, PostingGone | PostingUnavailable>;
  }
>()("@rat-stack/core/PostingTexts") {}
