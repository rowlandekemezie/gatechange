import { Effect } from "effect";
import { Runtime } from "foldkit";

import { application } from "./application.js";
import { Message } from "./board/message.js";
import { Preload } from "./board/model.js";
import { JobQueries } from "./board/queries.js";

import "../styles.css";

const served = document.querySelector<HTMLElement>("[data-foldkit-app]");

const program = Runtime.makeApplication({
  ...application,
  container: served ?? document.querySelector<HTMLElement>("#root"),
  devTools: import.meta.env.DEV ? { Message } : false,
  resources: JobQueries.layer,
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
