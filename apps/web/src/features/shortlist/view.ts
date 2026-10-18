import { isOffSiteWebUrl } from "@rat-stack/core/contracts";
import { Array, pipe } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../../client/board/message.js";
import type { MessageValue } from "../../client/board/message.js";
import type {
  MarkedJobValue,
  MarkKindValue,
  ModelValue,
} from "../../client/board/model.js";
import { jobRouter } from "../../client/route.js";

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
              h.a(
                [
                  h.Class("job-source"),
                  ...(isOffSiteWebUrl(mark.url) ? [h.Href(mark.url)] : []),
                  h.Target("_blank"),
                  h.Rel("noopener noreferrer"),
                ],
                ["Original posting"]
              ),
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

const section = (
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

const marksView = (model: ModelValue, h: HtmlBuilder<MessageValue>): Html =>
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
        ]
      )
    : h.div(
        [],
        [
          section(model, h, "Saved", "Saved"),
          section(model, h, "Applied", "Applied"),
        ]
      );

export const shortlistPage = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): Html =>
  h.div(
    [],
    [
      h.h1([h.Class("detail-title page-title")], ["Your shortlist"]),
      marksView(model, h),
    ]
  );
