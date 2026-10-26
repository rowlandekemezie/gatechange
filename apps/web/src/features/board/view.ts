import {
  currencies,
  offSiteHref,
  roleLevels,
  seniorities,
  SOURCE_REPOSITORY_URL,
} from "@rat-stack/core/contracts";
import type {
  JobDetailValue,
  ListedJobValue,
  RoleLevelValue,
} from "@rat-stack/core/contracts";
import { Array, DateTime, Match, Option, pipe } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { isFreeViewer } from "../../client/billing/model.js";
import {
  ageChip,
  bandLabel,
  dayHeading,
  postedAgo,
  postedShort,
  refreshedAgo,
  regionGroupChip,
  regionLabel,
  roleChip,
  roleCount,
  seniorityChip,
  sourceLabel,
  statusLabel,
  thousands,
} from "../../client/board/copy.js";
import {
  ageWindows,
  hasProSelection,
  MORE_PAGE_SIZE,
  regionGroups,
  salarySteps,
} from "../../client/board/filters.js";
import type {
  AgeWindowValue,
  PayFloorValue,
  RegionGroupValue,
} from "../../client/board/filters.js";
import { markButtons, stageOf } from "../../client/board/marks.js";
import { Message } from "../../client/board/message.js";
import type { MessageValue } from "../../client/board/message.js";
import { JobsState, MoreState, StatsState } from "../../client/board/model.js";
import type { ModelValue } from "../../client/board/model.js";
import { jobRouter, pricingRouter } from "../../client/route.js";
import { addServerCommandOf } from "../agent-tokens/view.js";
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

  return h.p(
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

const currencySelect = (
  h: HtmlBuilder<MessageValue>,
  floor: PayFloorValue
): Html =>
  h.label(
    [h.Class("phrase-group")],
    [
      h.span([h.Class("visually-hidden")], ["Pay currency"]),
      h.select(
        [
          h.Class("phrase phrase-on phrase-select"),
          h.OnChange((value) =>
            Message.ChangedPayCurrency({
              currency: pipe(
                currencies,
                Array.findFirst((currency) => currency === value),
                Option.getOrElse(() => floor.currency)
              ),
            })
          ),
        ],
        pipe(
          currencies,
          Array.map((currency) =>
            h.option(
              [h.Value(currency), h.Selected(currency === floor.currency)],
              [currency]
            )
          )
        )
      ),
    ]
  );

const refineView = (model: ModelValue, h: HtmlBuilder<MessageValue>): Html => {
  const { salaryFloor } = model.filters;

  const levels = [
    chip(
      h,
      Array.isReadonlyArrayEmpty(model.filters.seniorities),
      "any",
      Message.ClickedAnySeniority()
    ),
    ...pipe(
      seniorities,
      Array.map((seniority) =>
        chip(
          h,
          Array.contains(model.filters.seniorities, seniority),
          seniorityChip(seniority),
          Message.ToggledSeniority({ seniority })
        )
      )
    ),
  ];

  const steps = pipe(
    salarySteps,
    Array.map((amount) =>
      chip(
        h,
        salaryFloor?.amount === amount,
        thousands(amount),
        Message.ChangedPayFloor({ amount })
      )
    )
  );

  return h.p(
    [h.Class("sentence sentence-refine")],
    [
      "At ",
      ...listed(h, levels, "or", ""),
      " level, with ",
      chip(
        h,
        salaryFloor === null,
        "any pay",
        Message.ChangedPayFloor({ amount: null })
      ),
      " or a stated band reaching ",
      ...listed(h, steps, "or", salaryFloor === null ? "." : ""),
      ...(salaryFloor === null
        ? []
        : [" in ", currencySelect(h, salaryFloor), "."]),
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

const proFilterView = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): Html => {
  const freeViewer = isFreeViewer(model.account.session, model.billing);

  const selected = hasProSelection(model.filters);

  return h.details(
    [
      h.Class("pro-refinements"),
      h.Open(model.proFiltersOpen),
      h.OnToggle((isOpen) => Message.ToggledProFilters({ isOpen })),
    ],
    [
      h.summary(
        [h.Class("pro-refinements-title")],
        ["Salary and seniority ", h.span([h.Class("pro-badge")], ["Pro"])]
      ),
      h.fieldset(
        [
          h.Class("pro-refinements-fields"),
          ...(freeViewer ? [h.AriaDescribedBy("pro-refinements-note")] : []),
        ],
        [
          h.legend([h.Class("visually-hidden")], ["Salary and seniority"]),
          ...(freeViewer
            ? [
                h.p(
                  [h.Id("pro-refinements-note"), h.Class("upgrade-prompt")],
                  [
                    "Salary and seniority filters come with Pro. ",
                    selected
                      ? "These selections are not applied on Free. "
                      : "These filters are not applied on Free. ",
                    h.a([h.Href(pricingRouter())], ["See Pro plans"]),
                  ]
                ),
              ]
            : []),
          refineView(model, h),
          h.div(
            [h.Class("pro-filters")],
            [
              chip(
                h,
                model.filters.salaryListed,
                "Only roles that state a salary",
                Message.ToggledSalaryListed()
              ),
            ]
          ),
        ]
      ),
    ]
  );
};

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
      h.div(
        [h.Class("hero")],
        [
          h.p(
            [h.Class("kicker")],
            ["Remote · US & Canada · Checked every 20 min"]
          ),
          h.h1([h.Class("hero-title")], ["Your next move is on the board."]),
          h.p(
            [h.Class("hero-lede")],
            [
              "Director, VP and Head of Engineering roles, straight from company job boards. No ghost jobs: when a company takes a role down, it leaves the board.",
            ]
          ),
        ]
      ),
      h.div(
        [h.Class("filters")],
        [
          sentenceView(model, h),
          h.div(
            [h.Class("filter-tools")],
            [searchView(model, h), proFilterView(model, h)]
          ),
          h.submodel({
            model: model.savedSearches,
            slotId: "save-search",
            toParentMessage: (message) =>
              Message.GotSavedSearchesMessage({ message }),
            view: saveSearchControl,
            viewInputs: {
              filters: model.filters,
              session: model.account.session,
            },
          }),
          statusLine(model, h),
        ]
      ),
    ]
  );

export const boardAfterword = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): Html =>
  h.div(
    [h.Class("afterword")],
    [
      h.section(
        [h.Id("agents"), h.Class("agents"), h.AriaLabelledBy("agents-title")],
        [
          h.div(
            [h.Class("agents-copy")],
            [
              h.h2([h.Id("agents-title")], ["For agents"]),
              h.p(
                [],
                [
                  "Let your agent watch the board. Connect over MCP and ask Claude Code, Cursor or any MCP client which roles fit you. No key needed to start; Pro agent tokens get higher limits.",
                ]
              ),
            ]
          ),
          h.pre(
            [h.Class("agents-command"), h.Tabindex(0)],
            [h.code([], [addServerCommandOf(model.origin)])]
          ),
        ]
      ),
      h.section(
        [h.Class("open-source"), h.AriaLabelledBy("open-source-title")],
        [
          h.h2([h.Id("open-source-title")], ["Open source"]),
          h.p(
            [],
            [
              "The board, the crawler and the agent tools are MIT licensed. Read the code, file an issue or send a fix.",
            ]
          ),
          h.a(
            [h.Class("repo-link"), h.Href(SOURCE_REPOSITORY_URL)],
            ["View the code on GitHub"]
          ),
        ]
      ),
    ]
  );

const whereOf = (job: JobDetailValue) =>
  job.location.length > 0 ? job.location : regionLabel(job.region);

const payTag = (
  h: HtmlBuilder<MessageValue>,
  job: JobDetailValue
): readonly Html[] =>
  pipe(
    Option.fromNullishOr(job.enrichment?.salary),
    Option.map(bandLabel),
    Option.orElse(() => Option.fromNullishOr(job.salary)),
    Option.match({
      onNone: () => [],
      onSome: (pay) => [h.span([h.Class("job-pay")], [pay])],
    })
  );

const sourceLink = (h: HtmlBuilder<MessageValue>, job: JobDetailValue): Html =>
  h.a(
    [
      h.Class("job-source"),
      ...Option.toArray(
        Option.map(offSiteHref(job.url), (href) => h.Href(href))
      ),
      h.Target("_blank"),
      h.Rel("noopener noreferrer"),
    ],
    [`From ${sourceLabel(job.source)}`]
  );

const postedTime = (
  h: HtmlBuilder<MessageValue>,
  job: JobDetailValue,
  label: string
): Html =>
  h.time(
    [h.Datetime(DateTime.formatIso(DateTime.makeUnsafe(job.postedAt)))],
    [label]
  );

const isAppliedTo = (model: ModelValue, job: JobDetailValue) =>
  Option.exists(stageOf(model, job.id), (stage) => stage !== "Saved");

export const jobRow = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
  job: JobDetailValue,
  now: number
): Html => {
  const isApplied = isAppliedTo(model, job);

  const isNew = now - job.firstSeenAt < NEW_WINDOW;

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
                [whereOf(job)]
              ),
              ...payTag(h, job),
              sourceLink(h, job),
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
              postedTime(h, job, postedAgo(now, job.postedAt)),
            ]
          ),
          markButtons(model, h, job),
        ]
      ),
    ]
  );
};

const departureRow = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
  job: ListedJobValue,
  now: number
): Html =>
  h.keyed("li")(
    job.id,
    [
      h.Class(
        isAppliedTo(model, job) ? "departure departure-applied" : "departure"
      ),
    ],
    [
      h.a(
        [h.Class("departure-tiles"), h.Href(jobRouter({ id: job.id }))],
        [
          h.span([h.Class("tile cell-role")], [job.title]),
          h.span([h.Class("tile cell-company")], [job.company]),
          h.span(
            [h.Class("tile cell-where"), h.Title(regionLabel(job.region))],
            [whereOf(job)]
          ),
          h.span(
            [h.Class(`tile cell-status status-${job.status}`)],
            [statusLabel(job.status)]
          ),
          h.span(
            [h.Class("tile cell-posted")],
            [postedTime(h, job, postedShort(now, job.postedAt))]
          ),
        ]
      ),
      h.div(
        [h.Class("departure-meta")],
        [...payTag(h, job), sourceLink(h, job), markButtons(model, h, job)]
      ),
    ]
  );

const boardHead = (h: HtmlBuilder<MessageValue>): Html =>
  h.div(
    [h.Class("board-head"), h.AriaHidden(true)],
    [
      h.span([h.Class("cell-posted")], ["Posted"]),
      h.span([h.Class("cell-role")], ["Role"]),
      h.span([h.Class("cell-company")], ["Company"]),
      h.span([h.Class("cell-where")], ["Remote"]),
      h.span([h.Class("cell-status")], ["Status"]),
    ]
  );

const legendView = (h: HtmlBuilder<MessageValue>): Html =>
  h.ul(
    [h.Class("board-legend")],
    [
      h.li(
        [],
        [
          h.span([h.Class("status-new")], ["New"]),
          " · first seen in the last 24 hours",
        ]
      ),
      h.li(
        [],
        [
          h.span([h.Class("status-boarding")], ["Boarding"]),
          " · posted this week",
        ]
      ),
    ]
  );

const groupedRows = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
  jobs: readonly ListedJobValue[],
  now: number
): readonly Html[] => {
  if (model.filters.sort === "Relevance") {
    return [
      h.ol(
        [h.Class("jobs")],
        pipe(
          jobs,
          Array.map((job) => departureRow(model, h, job, now))
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
              Array.map((job) => departureRow(model, h, job, now))
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
        [`Show ${Math.min(MORE_PAGE_SIZE, total - shown)} more`]
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
          "Pick at least one role and one place, widen the window to a month, open up the level or pay, or clear the search.",
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
              h.div(
                [h.Class("board")],
                [boardHead(h), ...groupedRows(model, h, jobs, generatedAt)]
              ),
              legendView(h),
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
