import * as Alchemy from "alchemy";
import { Stage } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Website } from "./src/website.js";

export default Alchemy.Stack(
  "JobBoard",
  {
    providers: Cloudflare.providers().pipe(
      Layer.provideMerge(Stripe.providers())
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* stack() {
    if ((yield* Stage) === "preview") {
      yield* Cloudflare.Worker("PullRequestBackend", {
        main: "src/pr-preview-parent.ts",
        name: "jobs-pr-backend",
        workersDev: { enabled: false, previewsEnabled: true },
      });
    }

    const website = yield* Website;

    return { websiteUrl: website.url };
  })
);
