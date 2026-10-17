import { Layer } from "effect";
import { Runtime } from "foldkit";

import { AuthClient } from "./account/auth-client.js";
import { Message } from "./board/message.js";
import { Model } from "./board/model.js";
import { JobQueries } from "./board/queries.js";
import { init, routing, update } from "./board/update.js";
import { view } from "./board/view.js";

import "../styles.css";

const application = Runtime.makeApplication({
  Model,
  container: document.querySelector("#root"),
  devTools: import.meta.env.DEV ? { Message } : false,
  init,
  resources: Layer.mergeAll(JobQueries.layer, AuthClient.layer),
  routing,
  update,
  view,
});

Runtime.run(application);
