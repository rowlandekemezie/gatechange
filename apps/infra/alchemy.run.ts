import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { Website } from "./src/website.js";

export default Alchemy.Stack(
  "JobBoard",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* stack() {
    const website = yield* Website;

    return { websiteUrl: website.url };
  })
);
