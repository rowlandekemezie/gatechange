import { Context } from "effect";
import type { Effect } from "effect";

import type { JobValue } from "./job.js";
import type { PostingUnavailable } from "./posting-unavailable.js";

export class PostingTexts extends Context.Service<
  PostingTexts,
  {
    readonly fetch: (
      job: JobValue
    ) => Effect.Effect<string, PostingUnavailable>;
  }
>()("@rat-stack/core/PostingTexts") {}
