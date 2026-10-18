import { roleLevels } from "@rat-stack/core/contracts";
import type { JobValue, RoleLevelValue } from "@rat-stack/core/contracts";
import { Array, DateTime, Match, Option, pipe } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

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
} from "../../client/board/copy.js";
import { ageWindows, regionGroups } from "../../client/board/filters.js";
import type {
  AgeWindowValue,
  RegionGroupValue,
} from "../../client/board/filters.js";
import { markButtons, markKindOf } from "../../client/board/marks.js";
import { Message } from "../../client/board/message.js";
import type { MessageValue } from "../../client/board/message.js";
import { JobsState, MoreState, StatsState } from "../../client/board/model.js";
import type { ModelValue } from "../../client/board/model.js";
import { jobRouter } from "../../client/route.js";
import { saveSearchControl } from "../saved-searches/view.js";

const NEW_WINDOW = 86_400_000;

const chip = (
  h: HtmlBuilder<MessageValue>,
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
  h: HtmlBuilder<MessageValue>,
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

const sentenceView = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): Html => {
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

const searchView = (model: ModelValue, h: HtmlBuilder<MessageValue>): Html =>
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

const statusLine = (model: ModelValue, h: HtmlBuilder<MessageValue>): Html =>
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

export const boardMasthead = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): Html =>
  h.header(
    [h.Class("masthead")],
    [
      sentenceView(model, h),
      searchView(model, h),
      h.submodel({
        model: model.savedSearches,
        slotId: "save-search",
        toParentMessage: (message) =>
          Message.GotSavedSearchesMessage({ message }),
        view: saveSearchControl,
        viewInputs: { filters: model.filters, session: model.account.session },
      }),
      statusLine(model, h),
    ]
  );

export const jobRow = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
  job: JobValue,
  now: number
): Html => {
  const isApplied = Option.contains(markKindOf(model, job.id), "Applied");
  const isNew = now - job.firstSeenAt < NEW_WINDOW;

  const where =
    job.location.length > 0 ? job.location : regionLabel(job.region);

  return h.keyed("li")(
    job.id,
    [h.Class(isApplied ? "job job-applied" : "job")],
    [
      h.div(
        [h.Class("job-main")],
        [
          h.a(
            [h.Class("job-title"), h.Href(jobRouter({ id: job.id }))],
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
              h.a(
                [
                  h.Class("job-source"),
                  h.Href(job.url),
                  h.Target("_blank"),
                  h.Rel("noopener noreferrer"),
                ],
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
          markButtons(model, h, job),
        ]
      ),
    ]
  );
};

const groupedRows = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
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
  h: HtmlBuilder<MessageValue>,
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

const emptyView = (h: HtmlBuilder<MessageValue>): Html =>
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

const findingRoles = (h: HtmlBuilder<MessageValue>): Html =>
  h.p([h.Class("count"), h.Role("status")], ["Finding roles"]);

export const boardPage = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): Html =>
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
    Loading: () => findingRoles(h),
    NotAsked: () => findingRoles(h),
  });

export const boardTitle = (model: ModelValue) =>
  JobsState.match<string>(model.jobs, {
    Failed: () => "Engineering leadership roles",
    Loaded: ({ total }) => `${total} engineering leadership roles`,
    Loading: () => "Engineering leadership roles",
    NotAsked: () => "Engineering leadership roles",
  });
