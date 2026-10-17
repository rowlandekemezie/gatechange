import type { JobValue } from "@rat-stack/core/contracts";
import { Array, DateTime, Option, pipe } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import {
  postedAgo,
  regionLabel,
  sourceLabel,
} from "../../client/board/copy.js";
import { Message } from "../../client/board/message.js";
import type { MessageValue } from "../../client/board/message.js";
import { JobState } from "../../client/board/model.js";
import type {
  MarkedJobValue,
  MarkKindValue,
  ModelValue,
} from "../../client/board/model.js";
import { boardUrl } from "../../client/route.js";

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

const backLink = (model: ModelValue, h: HtmlBuilder<MessageValue>): Html =>
  h.a(
    [h.Class("back"), h.Href(boardUrl(model.filters))],
    ["Back to open roles"]
  );

const foundView = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
  job: JobValue
): Html => {
  const where =
    job.location.length > 0 ? job.location : regionLabel(job.region);

  return h.article(
    [h.Class("detail")],
    [
      backLink(model, h),
      h.h1([h.Class("detail-title")], [job.title]),
      h.p([h.Class("job-company")], [job.company]),
      h.dl(
        [h.Class("detail-facts")],
        [
          h.dt([], ["Where"]),
          h.dd([], [where]),
          h.dt([], ["Region"]),
          h.dd([], [regionLabel(job.region)]),
          ...(job.salary === null
            ? []
            : [h.dt([], ["Pay"]), h.dd([], [job.salary])]),
          h.dt([], ["Posted"]),
          h.dd(
            [],
            [
              h.time(
                [
                  h.Datetime(
                    DateTime.formatIso(DateTime.makeUnsafe(job.postedAt))
                  ),
                ],
                [postedAgo(job.lastSeenAt, job.postedAt)]
              ),
            ]
          ),
          h.dt([], ["Source"]),
          h.dd([], [sourceLabel(job.source)]),
        ]
      ),
      h.div(
        [h.Class("detail-actions")],
        [
          h.a(
            [
              h.Class("apply"),
              h.Href(job.url),
              h.Target("_blank"),
              h.Rel("noopener noreferrer"),
            ],
            [`Apply on ${sourceLabel(job.source)}`]
          ),
          markButtons(model, h, job),
        ]
      ),
    ]
  );
};

const missingView = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
  id: string
): Html =>
  h.div(
    [h.Class("empty detail"), h.Role("alert")],
    [
      h.h1([h.Class("detail-title")], ["This role is no longer on the board"]),
      h.p(
        [],
        ["Its source took the posting down, or it is older than 30 days."]
      ),
      ...Option.match(markOf(model, id), {
        onNone: () => [],
        onSome: (mark) => [
          h.p(
            [],
            [
              `You tracked ${mark.title} at ${mark.company}. `,
              h.a(
                [
                  h.Href(mark.url),
                  h.Target("_blank"),
                  h.Rel("noopener noreferrer"),
                ],
                ["Open the original posting"]
              ),
            ]
          ),
        ],
      }),
      backLink(model, h),
    ]
  );

export const jobPage = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): Html =>
  JobState.match<Html>(model.job, {
    Failed: ({ message }) =>
      h.div(
        [h.Class("empty detail"), h.Role("alert")],
        [
          h.p([], [message]),
          h.button(
            [
              h.Type("button"),
              h.Class("more"),
              h.OnClick(Message.ClickedRetryJob()),
            ],
            ["Try again"]
          ),
          backLink(model, h),
        ]
      ),
    Found: ({ job }) => foundView(model, h, job),
    Loading: () => h.p([h.Class("count"), h.Role("status")], ["Finding role"]),
    Missing: ({ id }) => missingView(model, h, id),
    NotAsked: () => h.empty,
  });

export const jobTitle = (model: ModelValue) =>
  JobState.match<string>(model.job, {
    Failed: () => "Role unavailable",
    Found: ({ job }) => `${job.title} at ${job.company}`,
    Loading: () => "Engineering leadership role",
    Missing: () => "Role not found",
    NotAsked: () => "Engineering leadership role",
  });
