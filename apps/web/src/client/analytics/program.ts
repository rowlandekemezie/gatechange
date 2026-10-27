import type { Url } from "foldkit/url";

import { application } from "../application.js";
import { TrackAnalytics } from "../board/command.js";
import type { MessageValue } from "../board/message.js";
import type { FlagsValue, ModelValue } from "../board/model.js";
import { callsOf, landingCallsOf } from "./events.js";
import type { AnalyticsCallValue } from "./events.js";

const tracked = <C>(
  result: { readonly commands?: readonly C[]; readonly model: ModelValue },
  calls: readonly AnalyticsCallValue[]
) =>
  calls.length === 0
    ? result
    : {
        ...result,
        commands: [...(result.commands ?? []), TrackAnalytics({ calls })],
      };

export const trackedApplication = {
  ...application,
  init: (flags: FlagsValue, url: Url) => {
    const result = application.init(flags, url);

    return tracked(result, landingCallsOf(result.model));
  },
  update: (model: ModelValue, message: MessageValue) => {
    const result = application.update(model, message);

    return tracked(result, callsOf(message, model, result.model));
  },
};
