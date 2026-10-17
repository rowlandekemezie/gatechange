import { roleLevels } from "@rat-stack/core/contracts";
import type { JobValue, RoleLevelValue } from "@rat-stack/core/contracts";
import { Array, DateTime, Match, Option, pipe, Schema } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { SourceTerms } from "../../../../../packages/job-sources/src/source-terms.js";
import type { SourceTermsValue } from "../../../../../packages/job-sources/src/source-terms.js";
import {
  ageChip,
  dayHeading,
  postedAgo,
  refreshedAgo,
  regionGroupChip,
  regionLabel,
  roleChip,
  roleCount,
  sourceLabel,
} from "./copy.js";
import { ageWindows, regionGroups } from "./filters.js";
import type { AgeWindowValue, RegionGroupValue } from "./filters.js";
import { Message } from "./message.js";
import type { MessageValue } from "./message.js";
import { JobsState, MoreState, StatsState } from "./model.js";
import type { MarkedJobValue, MarkKindValue, ModelValue } from "./model.js";

type H = HtmlBuilder<MessageValue>;

const NEW_WINDOW = 86_400_000;

const chip = (
  h: H,
  isOn: boolean,
  label: string,
  onClick: MessageValue
): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class(isOn ? "phrase phrase-on" : "phrase"),
      h.AriaPressed(isOn ? "true" : "false"),
      h.OnClick(onClick),
    ],
    [label]
  );

const listed = (
  h: H,
  items: readonly Html[],
  conjunction: string,
  trailing: string
): readonly (Html | string)[] =>
  pipe(
    items,
    Array.flatMap((item, index) => {
      const after = Match.value(items.length - 1 - index).pipe(
        Match.withReturnType<string>(),
        Match.when(0, () => trailing),
        Match.when(1, () => ` ${conjunction}`),
        Match.orElse(() => ",")
      );

      const group = h.span([h.Class("phrase-group")], [item, after]);

      return index === 0 ? [group] : [" ", group];
    })
  );

const sentenceView = (model: ModelValue, h: H): Html => {
  const { filters } = model;

  const roles = pipe(
    roleLevels,
    Array.map((role: RoleLevelValue) =>
      chip(
        h,
        Array.contains(filters.roles, role),
        roleChip(role),
        Message.ToggledRole({ role })
      )
    )
  );

  const places = pipe(
    regionGroups,
    Array.map((group: RegionGroupValue) =>
      chip(
        h,
        Array.contains(filters.regionGroups, group),
        regionGroupChip(group),
        Message.ToggledRegionGroup({ group })
      )
    )
  );

  const ages = pipe(
    ageWindows,
    Array.map((maxAgeDays: AgeWindowValue) =>
      chip(
        h,
        filters.maxAgeDays === maxAgeDays,
        ageChip(maxAgeDays),
        Message.ChangedAge({ maxAgeDays })
      )
    )
  );

  return h.h1(
    [h.Class("sentence")],
    [
      "Show me ",
      ...listed(h, roles, "and", ""),
      " roles that are ",
      ...listed(h, places, "or", ","),
      " posted in the last ",
      ...listed(h, ages, "or", ","),
      " with the ",
      ...listed(
        h,
        [
          chip(
            h,
            filters.sort === "Relevance",
            "most relevant",
            Message.ChangedSort({ sort: "Relevance" })
          ),
          chip(
            h,
            filters.sort === "Newest",
            "newest",
            Message.ChangedSort({ sort: "Newest" })
          ),
        ],
        "or",
        " first."
      ),
    ]
  );
};

const searchView = (model: ModelValue, h: H): Html =>
  h.form(
    [
      h.Class("search"),
      h.Role("search"),
      h.OnSubmit(Message.SubmittedSearch()),
    ],
    [
      h.label(
        [h.For("search"), h.Class("visually-hidden")],
        ["Filter by company, title or city"]
      ),
      h.input([
        h.Id("search"),
        h.Type("search"),
        h.Name("q"),
        h.Value(model.draftSearch),
        h.Placeholder("Filter by company, title or city"),
        h.Autocomplete("off"),
        h.OnInput((value) => Message.UpdatedDraftSearch({ value })),
      ]),
      h.button([h.Type("submit"), h.Class("search-button")], ["Search"]),
    ]
  );

const markOf = (model: ModelValue, id: string): Option.Option<MarkedJobValue> =>
  Array.findFirst(model.marks, (mark) => mark.id === id);

const markButton = (
  h: H,
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

const jobRow = (model: ModelValue, h: H, job: JobValue, now: number): Html => {
  const current = pipe(
    markOf(model, job.id),
    Option.map((mark) => mark.kind)
  );

  const isNew = now - job.firstSeenAt < NEW_WINDOW;

  const where =
    job.location.length > 0 ? job.location : regionLabel(job.region);

  return h.keyed("li")(
    job.id,
    [h.Class(Option.contains(current, "Applied") ? "job job-applied" : "job")],
    [
      h.div(
        [h.Class("job-main")],
        [
          h.a(
            [
              h.Class("job-title"),
              h.Href(job.url),
              h.Target("_blank"),
              h.Rel("noopener noreferrer"),
            ],
            [job.title]
          ),
          h.p([h.Class("job-company")], [job.company]),
          h.p(
            [h.Class("job-meta")],
            [
              h.span(
                [h.Class("job-where"), h.Title(regionLabel(job.region))],
                [where]
              ),
              ...(job.salary === null
                ? []
                : [h.span([h.Class("job-pay")], [job.salary])]),
              h.span(
                [h.Class("job-source")],
                [`From ${sourceLabel(job.source)}`]
              ),
            ]
          ),
        ]
      ),
      h.div(
        [h.Class("job-side")],
        [
          h.p(
            [h.Class("job-age")],
            [
              ...(isNew ? [h.span([h.Class("fresh")], ["New"])] : []),
              h.time(
                [
                  h.Datetime(
                    DateTime.formatIso(DateTime.makeUnsafe(job.postedAt))
                  ),
                ],
                [postedAgo(now, job.postedAt)]
              ),
            ]
          ),
          h.div(
            [
              h.Class("job-actions"),
              h.AriaLabel(`Track ${job.title} at ${job.company}`),
            ],
            [
              markButton(h, job, "Saved", current),
              markButton(h, job, "Applied", current),
            ]
          ),
        ]
      ),
    ]
  );
};

const groupedRows = (
  model: ModelValue,
  h: H,
  jobs: readonly JobValue[],
  now: number
): readonly Html[] => {
  if (model.filters.sort === "Relevance") {
    return [
      h.ol(
        [h.Class("jobs")],
        pipe(
          jobs,
          Array.map((job) => jobRow(model, h, job, now))
        )
      ),
    ];
  }

  if (!Array.isReadonlyArrayNonEmpty(jobs)) {
    return [];
  }

  const groups = Array.groupWith(
    jobs,
    (left, right) =>
      dayHeading(now, left.postedAt) === dayHeading(now, right.postedAt)
  );

  return pipe(
    groups,
    Array.map((group) => {
      const heading = dayHeading(now, Array.headNonEmpty(group).postedAt);

      return h.keyed("section")(
        heading,
        [h.Class("day")],
        [
          h.h2([h.Class("day-heading")], [heading]),
          h.ol(
            [h.Class("jobs")],
            pipe(
              group,
              Array.map((job) => jobRow(model, h, job, now))
            )
          ),
        ]
      );
    })
  );
};

const moreView = (
  model: ModelValue,
  h: H,
  shown: number,
  total: number
): Html => {
  if (shown >= total) {
    return h.p(
      [h.Class("list-end")],
      [
        "That is every role that matches. Widen the window or add places to see more.",
      ]
    );
  }

  return MoreState.match<Html>(model.more, {
    Failed: () =>
      h.div(
        [h.Class("list-end")],
        [
          h.p([h.Role("alert")], ["The next roles did not load."]),
          h.button(
            [
              h.Type("button"),
              h.Class("more"),
              h.OnClick(Message.ClickedLoadMore()),
            ],
            ["Try again"]
          ),
        ]
      ),
    Idle: () =>
      h.button(
        [
          h.Type("button"),
          h.Class("more"),
          h.OnClick(Message.ClickedLoadMore()),
        ],
        [
          `Show ${Math.min(40, total - shown)} more of ${total - shown} remaining`,
        ]
      ),
    Loading: () =>
      h.p([h.Class("list-end"), h.Role("status")], ["Loading more roles"]),
  });
};

const emptyView = (h: H): Html =>
  h.div(
    [h.Class("empty")],
    [
      h.p([], ["No roles match that sentence yet."]),
      h.p(
        [],
        [
          "Pick at least one role and one place, widen the window to a month, or clear the search.",
        ]
      ),
      h.button(
        [
          h.Type("button"),
          h.Class("more"),
          h.OnClick(Message.ClickedResetFilters()),
        ],
        ["Reset the sentence"]
      ),
    ]
  );

const boardView = (model: ModelValue, h: H): Html =>
  JobsState.match<Html>(model.jobs, {
    Failed: ({ message }) =>
      h.div(
        [h.Class("empty"), h.Role("alert")],
        [
          h.p([], [message]),
          h.button(
            [
              h.Type("button"),
              h.Class("more"),
              h.OnClick(Message.ClickedRetry()),
            ],
            ["Try again"]
          ),
        ]
      ),
    Loaded: ({ generatedAt, jobs, total }) =>
      Array.isReadonlyArrayEmpty(jobs)
        ? emptyView(h)
        : h.div(
            [],
            [
              h.p([h.Class("count"), h.AriaLive("polite")], [roleCount(total)]),
              ...groupedRows(model, h, jobs, generatedAt),
              moreView(model, h, jobs.length, total),
            ]
          ),
    Loading: () => h.p([h.Class("count"), h.Role("status")], ["Finding roles"]),
  });

const shortlistView = (model: ModelValue, h: H): Html => {
  if (Array.isReadonlyArrayEmpty(model.marks)) {
    return h.div(
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
    );
  }

  const section = (kind: MarkKindValue, heading: string) => {
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
                Array.map((mark) =>
                  h.keyed("li")(
                    mark.id,
                    [h.Class("job")],
                    [
                      h.div(
                        [h.Class("job-main")],
                        [
                          h.a(
                            [
                              h.Class("job-title"),
                              h.Href(mark.url),
                              h.Target("_blank"),
                              h.Rel("noopener noreferrer"),
                            ],
                            [mark.title]
                          ),
                          h.p([h.Class("job-company")], [mark.company]),
                          h.p(
                            [h.Class("job-meta")],
                            [h.span([h.Class("job-where")], [mark.location])]
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
                              h.OnClick(
                                Message.ClickedClearMark({ id: mark.id })
                              ),
                            ],
                            ["Remove"]
                          ),
                        ]
                      ),
                    ]
                  )
                )
              )
            ),
          ]
        );
  };

  return h.div([], [section("Saved", "Saved"), section("Applied", "Applied")]);
};

const statusLine = (model: ModelValue, h: H): Html =>
  StatsState.match<Html>(model.stats, {
    Loaded: ({ stats }) =>
      h.p(
        [h.Class("status")],
        [
          `${stats.activeJobs} leadership roles from the last 30 days, ${stats.newToday} new today. `,
          pipe(
            Option.fromNullishOr(stats.lastRun),
            Option.match({
              onNone: () => "The first refresh has not run yet.",
              onSome: (run) =>
                `Refreshed ${refreshedAgo(stats.generatedAt, run.finishedAt)} from ${stats.feedsTotal} job boards.`,
            })
          ),
        ]
      ),
    Unavailable: () => h.empty,
  });

const tabs = (model: ModelValue, h: H): Html =>
  h.nav(
    [h.Class("tabs"), h.AriaLabel("Views")],
    [
      h.button(
        [
          h.Type("button"),
          h.Class(model.view === "Board" ? "tab tab-on" : "tab"),
          h.AriaPressed(model.view === "Board" ? "true" : "false"),
          h.OnClick(Message.ChangedView({ view: "Board" })),
        ],
        ["Open roles"]
      ),
      h.button(
        [
          h.Type("button"),
          h.Class(model.view === "Shortlist" ? "tab tab-on" : "tab"),
          h.AriaPressed(model.view === "Shortlist" ? "true" : "false"),
          h.OnClick(Message.ChangedView({ view: "Shortlist" })),
        ],
        [`Your shortlist (${model.marks.length})`]
      ),
    ]
  );

const sourcesOf = (kind: SourceTermsValue["kind"]) =>
  Object.values(SourceTerms).filter((terms) => terms.kind === kind);

const creditList = (items: readonly (Html | string)[]) =>
  items.flatMap((item, index) => {
    if (index === 0) {
      return [item];
    }

    return [index === items.length - 1 ? " and " : ", ", item];
  });

const footer = (h: H): Html =>
  h.footer(
    [h.Class("footer")],
    [
      h.p(
        [],
        [
          "Roles come from public company job boards on ",
          ...creditList(sourcesOf("CompanyBoard").map(({ label }) => label)),
          ", and from ",
          ...creditList(
            sourcesOf("Aggregator").map(({ creditUrl, label }) =>
              h.a([h.Href(creditUrl)], [label])
            )
          ),
          ". Each listing links to its original posting. Roles leave the board when their source removes them or after 30 days.",
        ]
      ),
      h.p(
        [],
        [
          h.a(
            [h.Href("https://rowlandekemezie.com")],
            ["Made by Rowland Ekemezie"]
          ),
        ]
      ),
    ]
  );

export const view = (model: ModelValue, h: H): Document => ({
  body: h.main(
    [h.Class("page")],
    [
      h.header(
        [h.Class("masthead")],
        [sentenceView(model, h), searchView(model, h), statusLine(model, h)]
      ),
      tabs(model, h),
      model.view === "Board" ? boardView(model, h) : shortlistView(model, h),
      footer(h),
    ]
  ),
  title: Schema.is(JobsState.Loaded)(model.jobs)
    ? `${model.jobs.total} engineering leadership roles`
    : "Engineering leadership roles",
});
