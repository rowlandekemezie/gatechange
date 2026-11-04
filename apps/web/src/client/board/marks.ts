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
  readonly location: string;
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

export const lineIcon = (h: HtmlBuilder<MessageValue>, d: string): Html =>
  h.svg(
    [h.ViewBox("0 0 20 20"), h.Width("20"), h.Height("20"), h.AriaHidden(true)],
    [
      h.path([
        h.D(d),
        h.Fill("none"),
        h.Stroke("currentColor"),
        h.StrokeWidth("1.8"),
        h.StrokeLinecap("round"),
        h.StrokeLinejoin("round"),
      ]),
    ]
  );

const MARK_ICONS: Readonly<Record<MarkKindValue, string>> = {
  Applied: "M4.5 10.5l3.5 3.5 7.5-8",
  Saved: "M6 3.5h8v13l-4-3-4 3Z",
};

const textOf = (kind: MarkKindValue, isOn: boolean) => {
  if (kind === "Applied") {
    return "Applied";
  }

  return isOn ? "Saved" : "Save";
};

const markButton = (
  h: HtmlBuilder<MessageValue>,
  job: JobValue,
  kind: MarkKindValue,
  current: Option.Option<StageValue>,
  isCompact: boolean
) => {
  const isOn = Option.contains(current, kind);
  const label = kind === "Saved" ? "Save" : "Applied";

  return h.button(
    [
      h.Type("button"),
      h.Class(isOn ? "mark mark-on" : "mark"),
      h.AriaPressed(isOn ? "true" : "false"),
      ...(isCompact ? [h.AriaLabel(label), h.Title(label)] : []),
      h.OnClick(
        isOn
          ? Message.ClickedClearMark({ id: job.id })
          : Message.ClickedMark({ job, kind })
      ),
    ],
    [isCompact ? lineIcon(h, MARK_ICONS[kind]) : textOf(kind, isOn)]
  );
};

const isMarkKind = (stage: StageValue): stage is MarkKindValue =>
  stage === "Saved" || stage === "Applied";

export const markButtons = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
  job: JobValue,
  isCompact = false
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
            markButton(h, job, "Saved", current, isCompact),
            markButton(h, job, "Applied", current, isCompact),
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
