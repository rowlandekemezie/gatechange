import { Runtime } from "foldkit";

import { Message } from "./board/message.js";
import { Model } from "./board/model.js";
import { JobQueries } from "./board/queries.js";
import { init, update } from "./board/update.js";
import { view } from "./board/view.js";

import "../styles.css";

const application = Runtime.makeApplication({
  Model: Model,
  container: document.querySelector("#root"),
  devTools: import.meta.env.DEV ? { Message: Message } : false,
  init,
  resources: JobQueries.layer,
  update,
  view,
});

Runtime.run(application);
