import { Flags, Model } from "./board/model.js";
import { init, routing, update } from "./board/update.js";
import { view } from "./board/view.js";

export const application = { Flags, Model, init, routing, update, view };
