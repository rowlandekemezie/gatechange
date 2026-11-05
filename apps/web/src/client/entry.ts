import { Effect, Layer } from "effect";
import { Runtime } from "foldkit";

import { AuthClient } from "./account/auth-client.js";
import { Analytics, campaignOf } from "./analytics/client.js";
import { trackedApplication } from "./analytics/program.js";
import { Message } from "./board/message.js";
import { Preload } from "./board/model.js";
import { JobQueries } from "./board/queries.js";

import "../styles.css";

const served = document.querySelector<HTMLElement>("[data-foldkit-app]");

const program = Runtime.makeApplication({
  ...trackedApplication,
  container: served ?? document.querySelector<HTMLElement>("#root"),
  devTools: import.meta.env.DEV ? { Message } : false,
  resources: Layer.mergeAll(
    JobQueries.layer.pipe(
      Layer.provideMerge(Analytics.layer(campaignOf(window.location.search)))
    ),
    AuthClient.layer
  ),
});

if (served === null) {
  Runtime.run(program, {
    flags: Effect.sync(() => ({
      origin: window.location.origin,
      preload: Preload.Nothing(),
    })),
  });
} else {
  Runtime.hydrate(program);
}
