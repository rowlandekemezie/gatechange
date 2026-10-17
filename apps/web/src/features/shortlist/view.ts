import { MAX_NOTES_LENGTH, Stage, stages } from "@rat-stack/core/contracts";
import type { StageValue, TrackedJobValue } from "@rat-stack/core/contracts";
import { Array, Option, pipe, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../../client/board/message.js";
import type { MessageValue } from "../../client/board/message.js";
import { TrackerState } from "../../client/board/model.js";
import type {
  MarkedJobValue,
  MarkKindValue,
  ModelValue,
  RemoteTrackerValue,
} from "../../client/board/model.js";
import { accountRouter, jobRouter } from "../../client/route.js";

const originalPosting = (h: HtmlBuilder<MessageValue>, url: string): Html =>
  h.a(
    [
      h.Class("job-source"),
      h.Href(url),
      h.Target("_blank"),
      h.Rel("noopener noreferrer"),
    ],
    ["Original posting"]
  );

const markRow = (h: HtmlBuilder<MessageValue>, mark: MarkedJobValue): Html =>
  h.keyed("li")(
    mark.id,
    [h.Class("job")],
    [
      h.div(
        [h.Class("job-main")],
        [
          h.a(
            [h.Class("job-title"), h.Href(jobRouter({ id: mark.id }))],
            [mark.title]
          ),
          h.p([h.Class("job-company")], [mark.company]),
          h.p(
            [h.Class("job-meta")],
            [
              h.span([h.Class("job-where")], [mark.location]),
              originalPosting(h, mark.url),
            ]
          ),
        ]
      ),
      h.div(
        [h.Class("job-side")],
        [
          h.button(
            [
              h.Type("button"),
              h.Class("mark"),
              h.OnClick(Message.ClickedClearMark({ id: mark.id })),
            ],
            ["Remove"]
          ),
        ]
      ),
    ]
  );

const localSection = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
  kind: MarkKindValue,
  heading: string
): Html => {
  const marks = pipe(
    model.marks,
    Array.filter((mark) => mark.kind === kind)
  );

  return Array.isReadonlyArrayEmpty(marks)
    ? h.empty
    : h.section(
        [h.Class("day")],
        [
          h.h2([h.Class("day-heading")], [`${heading} (${marks.length})`]),
          h.ol(
            [h.Class("jobs")],
            pipe(
              marks,
              Array.map((mark) => markRow(h, mark))
            )
          ),
        ]
      );
};

const syncInvite = (h: HtmlBuilder<MessageValue>): Html =>
  h.p(
    [h.Class("tracker-invite")],
    [
      h.a([h.Href(accountRouter({ notice: "None" }))], ["Sign in"]),
      " to keep this list on every device and follow each role through interviews and offers.",
    ]
  );

const localView = (model: ModelValue, h: HtmlBuilder<MessageValue>): Html =>
  Array.isReadonlyArrayEmpty(model.marks)
    ? h.div(
        [h.Class("empty")],
        [
          h.p([], ["Your shortlist is empty."]),
          h.p(
            [],
            [
              "Press Save or Applied on any role. The list stays in this browser and nothing leaves your device.",
            ]
          ),
          syncInvite(h),
        ]
      )
    : h.div(
        [],
        [
          localSection(model, h, "Saved", "Saved"),
          localSection(model, h, "Applied", "Applied"),
          syncInvite(h),
        ]
      );

const dayFormat = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
});

const datesLine = (job: TrackedJobValue) => {
  const saved = `Saved ${dayFormat.format(job.savedAt)}`;

  return job.movedAt === job.savedAt
    ? saved
    : `${saved} · ${job.stage} ${dayFormat.format(job.movedAt)}`;
};

const decodeStage = Schema.decodeUnknownOption(Stage);

const stagePicker = (
  h: HtmlBuilder<MessageValue>,
  job: TrackedJobValue
): Html => {
  const id = `stage-${job.jobId}`;

  return h.div(
    [h.Class("tracked-stage")],
    [
      h.label([h.For(id)], ["Stage"]),
      h.select(
        [
          h.Id(id),
          h.OnChange((value) =>
            Message.ChangedStage({
              jobId: job.jobId,
              stage: Option.getOrElse(decodeStage(value), () => job.stage),
            })
          ),
        ],
        stages.map((stage) =>
          h.option([h.Value(stage), h.Selected(stage === job.stage)], [stage])
        )
      ),
    ]
  );
};

const notesEditor = (
  h: HtmlBuilder<MessageValue>,
  job: TrackedJobValue
): Html => {
  const id = `notes-${job.jobId}`;

  return h.details(
    [h.Class("tracked-notes"), h.Open(job.notes !== "")],
    [
      h.summary([], [job.notes === "" ? "Add a note" : "Notes"]),
      h.label([h.For(id), h.Class("visually-hidden")], ["Notes"]),
      h.textarea([
        h.Id(id),
        h.Rows(3),
        h.Maxlength(MAX_NOTES_LENGTH),
        h.Value(job.notes),
        h.OnChange((notes) =>
          Message.ChangedNotes({ jobId: job.jobId, notes })
        ),
      ]),
    ]
  );
};

const trackedCard = (
  h: HtmlBuilder<MessageValue>,
  job: TrackedJobValue
): Html =>
  h.keyed("li")(
    job.jobId,
    [h.Class(job.listed ? "tracked" : "tracked tracked-closed")],
    [
      h.a(
        [h.Class("job-title"), h.Href(jobRouter({ id: job.jobId }))],
        [job.snapshot.title]
      ),
      h.p([h.Class("job-company")], [job.snapshot.company]),
      h.p(
        [h.Class("job-meta")],
        [
          h.span([h.Class("job-where")], [job.snapshot.location]),
          originalPosting(h, job.snapshot.url),
        ]
      ),
      ...(job.listed
        ? []
        : [
            h.p(
              [h.Class("tracked-closed-note")],
              [
                "This posting has closed. You are seeing what it said when you saved it.",
              ]
            ),
          ]),
      h.p([h.Class("tracked-dates")], [datesLine(job)]),
      h.div(
        [h.Class("tracked-controls")],
        [
          stagePicker(h, job),
          h.button(
            [
              h.Type("button"),
              h.Class("mark"),
              h.OnClick(Message.ClickedClearMark({ id: job.jobId })),
            ],
            ["Remove"]
          ),
        ]
      ),
      notesEditor(h, job),
    ]
  );

const inStage = (tracker: RemoteTrackerValue, stage: StageValue) =>
  pipe(
    tracker.jobs,
    Array.filter((job) => job.stage === stage)
  );

const pipelineSummary = (
  h: HtmlBuilder<MessageValue>,
  tracker: RemoteTrackerValue
): Html =>
  h.ol(
    [h.Class("pipeline"), h.AriaLabel("Pipeline")],
    stages.map((stage) =>
      h.li(
        [h.Class("pipeline-stage")],
        [
          h.span(
            [h.Class("pipeline-count")],
            [String(inStage(tracker, stage).length)]
          ),
          h.span([], [stage]),
        ]
      )
    )
  );

const stageSection = (
  h: HtmlBuilder<MessageValue>,
  tracker: RemoteTrackerValue,
  stage: StageValue
): Html => {
  const jobs = inStage(tracker, stage);

  return Array.isReadonlyArrayEmpty(jobs)
    ? h.empty
    : h.section(
        [h.Class("day")],
        [
          h.h2([h.Class("day-heading")], [`${stage} (${jobs.length})`]),
          h.ol(
            [h.Class("tracked-list")],
            jobs.map((job) => trackedCard(h, job))
          ),
        ]
      );
};

const problemBanner = (
  h: HtmlBuilder<MessageValue>,
  tracker: RemoteTrackerValue
): readonly Html[] =>
  Option.match(tracker.problem, {
    onNone: () => [],
    onSome: (problem) => [
      h.div(
        [h.Class("sign-in-problem"), h.Role("alert")],
        [
          h.p([], [problem]),
          h.button(
            [
              h.Type("button"),
              h.Class("more"),
              h.OnClick(Message.ClickedRetryTracker()),
            ],
            ["Try again"]
          ),
        ]
      ),
    ],
  });

const remoteView = (
  h: HtmlBuilder<MessageValue>,
  tracker: RemoteTrackerValue
): Html => {
  if (!tracker.loaded) {
    return h.div(
      [h.Class("empty")],
      [
        ...problemBanner(h, tracker),
        ...(Option.isNone(tracker.problem)
          ? [h.p([h.Role("status")], ["Loading your tracker…"])]
          : []),
      ]
    );
  }

  if (Array.isReadonlyArrayEmpty(tracker.jobs)) {
    return h.div(
      [h.Class("empty")],
      [
        ...problemBanner(h, tracker),
        h.p([], ["Your tracker is empty."]),
        h.p(
          [],
          [
            "Press Save or Applied on any role. It follows your account to every device you sign in on.",
          ]
        ),
      ]
    );
  }

  return h.div(
    [],
    [
      ...problemBanner(h, tracker),
      pipelineSummary(h, tracker),
      ...stages.map((stage) => stageSection(h, tracker, stage)),
    ]
  );
};

export const shortlistPage = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): Html =>
  h.div(
    [],
    [
      h.h1([h.Class("detail-title page-title")], ["Your shortlist"]),
      TrackerState.match<Html>(model.tracker, {
        Local: () => localView(model, h),
        Remote: (tracker) => remoteView(h, tracker),
      }),
    ]
  );
