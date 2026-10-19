import type { JobValue, StageValue } from "@rat-stack/core/contracts";
import { Array, Option, pipe } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { shortlistRouter } from "../route.js";
import { Message } from "./message.js";
import type { MessageValue } from "./message.js";
import { TrackerState } from "./model.js";
import type { MarkKindValue, ModelValue } from "./model.js";

export interface ShortlistEntry {
  readonly company: string;
  readonly stage: StageValue;
  readonly title: string;
  readonly url: string;
}

export const entryOf = (
  model: ModelValue,
  id: string
): Option.Option<ShortlistEntry> =>
  TrackerState.match<Option.Option<ShortlistEntry>>(model.tracker, {
    Local: () =>
      pipe(
        Array.findFirst(model.marks, (mark) => mark.id === id),
        Option.map((mark) => ({ ...mark, stage: mark.kind }))
      ),
    Remote: ({ jobs }) =>
      pipe(
        Array.findFirst(jobs, (job) => job.jobId === id),
        Option.map(({ snapshot, stage }) => ({ ...snapshot, stage }))
      ),
  });

export const stageOf = (
  model: ModelValue,
  id: string
): Option.Option<StageValue> =>
  TrackerState.match<Option.Option<StageValue>>(model.tracker, {
    Local: () =>
      pipe(
        Array.findFirst(model.marks, (mark) => mark.id === id),
        Option.map((mark) => mark.kind)
      ),
    Remote: ({ adding, jobs }) =>
      pipe(
        Array.findFirst(jobs, (job) => job.jobId === id),
        Option.orElse(() =>
          Array.findFirst(adding, (pending) => pending.jobId === id)
        ),
        Option.map(({ stage }) => stage)
      ),
  });

export const shortlistSize = (model: ModelValue) =>
  TrackerState.match<number>(model.tracker, {
    Local: () => model.marks.length,
    Remote: ({ adding, jobs }) => jobs.length + adding.length,
  });

const markButton = (
  h: HtmlBuilder<MessageValue>,
  job: JobValue,
  kind: MarkKindValue,
  current: Option.Option<StageValue>
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

const isMarkKind = (stage: StageValue): stage is MarkKindValue =>
  stage === "Saved" || stage === "Applied";

export const markButtons = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
  job: JobValue
): Html => {
  const current = stageOf(model, job.id);
  const label = `Track ${job.title} at ${job.company}`;

  return Option.match(
    pipe(
      current,
      Option.filter((stage) => !isMarkKind(stage))
    ),
    {
      onNone: () =>
        h.div(
          [h.Class("job-actions"), h.AriaLabel(label)],
          [
            markButton(h, job, "Saved", current),
            markButton(h, job, "Applied", current),
          ]
        ),
      onSome: (stage) =>
        h.div(
          [h.Class("job-actions"), h.AriaLabel(label)],
          [h.a([h.Class("mark mark-on"), h.Href(shortlistRouter())], [stage])]
        ),
    }
  );
};
