import { Runtime } from "foldkit";

import { Message } from "./client/board/message.js";
import { Model } from "./client/board/model.js";
import { JobQueries } from "./client/board/queries.js";
import { init, update } from "./client/board/update.js";
import { view } from "./features/board/view.js";

import "./styles.css";

const application = Runtime.makeApplication({
  Model,
  container: document.querySelector("#root"),
  devTools: import.meta.env.DEV ? { Message } : false,
  init,
  resources: JobQueries.layer,
  update,
  view,
});

Runtime.run(application);
