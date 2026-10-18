import { Context } from "effect";
import type { Effect } from "effect";

import type { Digest } from "./alerts.js";
import type { DigestMailerUnavailable } from "./digest-mailer-unavailable.js";

export class DigestMailer extends Context.Service<
  DigestMailer,
  {
    readonly send: (
      digest: Digest
    ) => Effect.Effect<void, DigestMailerUnavailable>;
  }
>()("@rat-stack/core/DigestMailer") {}
