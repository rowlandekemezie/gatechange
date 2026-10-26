import { companySlugOf, offSiteHref } from "@rat-stack/core/contracts";
import type {
  EnrichmentValue,
  JobDetailValue,
} from "@rat-stack/core/contracts";
import { Array, DateTime, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import {
  bandLabel,
  postedAgo,
  regionLabel,
  remotePolicyLabel,
  seniorityLabel,
  sourceLabel,
  teamSizeLabel,
} from "../../client/board/copy.js";
import { entryOf, markButtons } from "../../client/board/marks.js";
import { Message } from "../../client/board/message.js";
import type { MessageValue } from "../../client/board/message.js";
import { JobState } from "../../client/board/model.js";
import type { ModelValue } from "../../client/board/model.js";
import { boardUrl, companyRouter } from "../../client/route.js";

const backLink = (model: ModelValue, h: HtmlBuilder<MessageValue>): Html =>
  h.a(
    [h.Class("back"), h.Href(boardUrl(model.filters))],
    ["Back to open roles"]
  );

const fact = <A>(
  h: HtmlBuilder<MessageValue>,
  term: string,
  value: A | null,
  label: (value: A) => string
): readonly Html[] =>
  value === null ? [] : [h.dt([], [term]), h.dd([], [label(value)])];

const originNote = (
  h: HtmlBuilder<MessageValue>,
  { board, enrichedAt, model }: EnrichmentValue
): readonly (Html | string)[] => {
  if (model === null) {
    return ["From the company's job board. "];
  }

  const at = DateTime.makeUnsafe(enrichedAt);

  return [
    board === null
      ? `Extracted from the posting by Workers AI (${model}) on `
      : `From the company's job board, with the rest extracted from the posting by Workers AI (${model}) on `,
    h.time(
      [h.Datetime(DateTime.formatIso(at))],
      [DateTime.formatUtc(at, { dateStyle: "long", locale: "en-CA" })]
    ),
    ". ",
  ];
};

const enrichmentView = (
  h: HtmlBuilder<MessageValue>,
  enrichment: EnrichmentValue
): readonly Html[] => {
  const facts = [
    ...fact(h, "Seniority", enrichment.seniority, seniorityLabel),
    ...fact(h, "Team size", enrichment.teamSize, teamSizeLabel),
    ...fact(h, "Reports to", enrichment.reportsTo, (name) => name),
    ...fact(h, "Remote policy", enrichment.remotePolicy, remotePolicyLabel),
    ...fact(h, "Salary band", enrichment.salary, bandLabel),
  ];

  if (Array.isReadonlyArrayEmpty(facts)) {
    return [];
  }

  return [
    h.section(
      [h.Class("detail-extracted")],
      [
        h.h2([h.Class("detail-subhead")], ["About the role"]),
        h.dl([h.Class("detail-facts")], facts),
        h.p(
          [h.Class("detail-note")],
          [
            ...originNote(h, enrichment),
            "Check the posting before you rely on it.",
          ]
        ),
      ]
    ),
  ];
};

const foundView = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
  job: JobDetailValue
): Html => {
  const where =
    job.location.length > 0 ? job.location : regionLabel(job.region);

  return h.article(
    [h.Class("detail")],
    [
      backLink(model, h),
      h.h1([h.Class("detail-title")], [job.title]),
      h.p(
        [h.Class("job-company")],
        [
          Option.match(companySlugOf(job.company), {
            onNone: () => job.company,
            onSome: (slug) =>
              h.a([h.Href(companyRouter({ slug }))], [job.company]),
          }),
        ]
      ),
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
      ...(job.enrichment === null ? [] : enrichmentView(h, job.enrichment)),
      h.div(
        [h.Class("detail-actions")],
        [
          h.a(
            [
              h.Class("apply"),
              ...Option.toArray(
                Option.map(offSiteHref(job.url), (href) => h.Href(href))
              ),
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
        [
          "Its company took the posting down, or the board has not seen it for 30 days.",
        ]
      ),
      ...Option.match(entryOf(model, id), {
        onNone: () => [],
        onSome: (mark) => [
          h.p(
            [],
            [
              `You tracked ${mark.title} at ${mark.company}. `,
              h.a(
                [
                  ...Option.toArray(
                    Option.map(offSiteHref(mark.url), (href) => h.Href(href))
                  ),
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
          h.h1([h.Class("detail-title")], ["This role could not load"]),
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
    Loading: () =>
      h.div(
        [h.Class("empty detail"), h.Role("status")],
        [h.h1([h.Class("detail-title")], ["Finding role"])]
      ),
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
