import type { JobValue } from "@rat-stack/core/contracts";
import { Array, Option, pipe } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./message.js";
import type { MessageValue } from "./message.js";
import type { MarkedJobValue, MarkKindValue, ModelValue } from "./model.js";

export const markOf = (
  model: ModelValue,
  id: string
): Option.Option<MarkedJobValue> =>
  Array.findFirst(model.marks, (mark) => mark.id === id);

export const markKindOf = (model: ModelValue, id: string) =>
  pipe(
    markOf(model, id),
    Option.map((mark) => mark.kind)
  );

const markButton = (
  h: HtmlBuilder<MessageValue>,
  job: JobValue,
  kind: MarkKindValue,
  current: Option.Option<MarkKindValue>
) => {
  const isOn = Option.contains(current, kind);
  const label = kind === "Saved" ? "Save" : "Applied";

  return h.button(
    [
      h.Type("button"),
      h.Class(isOn ? "mark mark-on" : "mark"),
      h.AriaPressed(isOn ? "true" : "false"),
      h.OnClick(
        isOn
          ? Message.ClickedClearMark({ id: job.id })
          : Message.ClickedMark({ job, kind })
      ),
    ],
    [isOn && kind === "Saved" ? "Saved" : label]
  );
};

export const markButtons = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
  job: JobValue
): Html => {
  const current = markKindOf(model, job.id);

  return h.div(
    [
      h.Class("job-actions"),
      h.AriaLabel(`Track ${job.title} at ${job.company}`),
    ],
    [
      markButton(h, job, "Saved", current),
      markButton(h, job, "Applied", current),
    ]
  );
};
