import { Context } from "effect";
import type { Effect } from "effect";

import type { EnrichmentQueueUnavailable } from "./enrichment-queue-unavailable.js";

export class EnrichmentQueue extends Context.Service<
  EnrichmentQueue,
  {
    readonly enqueue: (
      ids: readonly string[]
    ) => Effect.Effect<void, EnrichmentQueueUnavailable>;
  }
>()("@rat-stack/core/EnrichmentQueue") {}
