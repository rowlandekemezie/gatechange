import { Array, Option, Schema, pipe } from "effect";
import type { Update } from "foldkit";
import { UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import { toString as urlToString } from "foldkit/url";
import type { Url } from "foldkit/url";

import { boardUrl, Route, routeOfUrl } from "../route.js";
import type { RouteValue } from "../route.js";
import {
  FetchJob,
  FetchJobs,
  FetchMoreJobs,
  FetchStats,
  LoadUrl,
  PushUrl,
  ReadShortlist,
  WriteShortlist,
} from "./command.js";
import {
  defaultFilters,
  Filters,
  hasNoSelection,
  queryOf,
  toggled,
} from "./filters.js";
import type { FiltersValue } from "./filters.js";
import { Message } from "./message.js";
import type { MessageValue } from "./message.js";
import { JobsState, JobState, MoreState, StatsState } from "./model.js";
import type { MarkedJobValue, ModelValue } from "./model.js";
import type { JobQueries } from "./queries.js";

type UpdateReturn = Update.Return<ModelValue, MessageValue, JobQueries>;

const sameFilters = Schema.toEquivalence(Filters);

const withFilters = (
  model: ModelValue,
  filters: FiltersValue
): UpdateReturn => {
  const generation = model.generation + 1;

  const nextModel = modifyFields(model, {
    filters: () => filters,
    generation: () => generation,
    more: () => MoreState.Idle(),
  });

  if (hasNoSelection(filters)) {
    return {
      model: modifyFields(nextModel, {
        jobs: () => JobsState.Loaded({ generatedAt: 0, jobs: [], total: 0 }),
      }),
    };
  }

  return {
    commands: [FetchJobs({ generation, query: queryOf(filters, 0) })],
    model: modifyFields(nextModel, { jobs: () => JobsState.Loading() }),
  };
};

const navigatedTo = (
  model: ModelValue,
  filters: FiltersValue
): UpdateReturn => {
  const applied = withFilters(model, filters);

  return {
    commands: [
      ...(applied.commands ?? []),
      PushUrl({ url: boardUrl(filters) }),
    ],
    model: applied.model,
  };
};

const listedJob = (model: ModelValue, id: string) =>
  Schema.is(JobsState.Loaded)(model.jobs)
    ? Array.findFirst(model.jobs.jobs, (job) => job.id === id)
    : Option.none();

const enteredJob = (model: ModelValue, id: string): UpdateReturn =>
  Option.match(listedJob(model, id), {
    onNone: () => ({
      commands: [FetchJob({ id })],
      model: modifyFields(model, { job: () => JobState.Loading({ id }) }),
    }),
    onSome: (job) => ({
      model: modifyFields(model, { job: () => JobState.Found({ job }) }),
    }),
  });

const entered = (model: ModelValue, route: RouteValue): UpdateReturn => {
  const routed = modifyFields(model, { route: () => route });

  return Route.match<UpdateReturn>(route, {
    Board: ({ filters }) =>
      Schema.is(JobsState.NotAsked)(model.jobs) ||
      !sameFilters(filters, model.filters)
        ? withFilters(
            modifyFields(routed, { draftSearch: () => filters.search }),
            filters
          )
        : { model: routed },
    Job: ({ id }) => enteredJob(routed, id),
    NotFound: () => ({ model: routed }),
    Shortlist: () => ({ model: routed }),
  });
};

const isAwaitingJob = (model: ModelValue, id: string) =>
  Schema.is(JobState.Loading)(model.job) && model.job.id === id;

const shortlistWith = (
  model: ModelValue,
  marks: readonly MarkedJobValue[]
): UpdateReturn => ({
  commands: [WriteShortlist({ marks })],
  model: modifyFields(model, { marks: () => marks }),
});

export const routing = {
  onUrlChange: (url: Url) => Message.ChangedUrl({ url }),
  onUrlRequest: (request: UrlRequest) => Message.ClickedLink({ request }),
};

export const init = (url: Url): UpdateReturn => {
  const route = routeOfUrl(url);

  const routed = entered(
    {
      draftSearch: "",
      filters: defaultFilters,
      generation: 0,
      job: JobState.NotAsked(),
      jobs: JobsState.NotAsked(),
      marks: [],
      more: MoreState.Idle(),
      route,
      stats: StatsState.Unavailable(),
    },
    route
  );

  return {
    commands: [...(routed.commands ?? []), FetchStats(), ReadShortlist()],
    model: routed.model,
  };
};

export const update = (
  model: ModelValue,
  message: MessageValue
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ChangedAge: ({ maxAgeDays }) =>
      navigatedTo(model, { ...model.filters, maxAgeDays }),
    ChangedSort: ({ sort }) => navigatedTo(model, { ...model.filters, sort }),
    ChangedUrl: ({ url }) => entered(model, routeOfUrl(url)),
    ClickedClearMark: ({ id }) =>
      shortlistWith(
        model,
        pipe(
          model.marks,
          Array.filter((mark) => mark.id !== id)
        )
      ),
    ClickedLink: ({ request }) => ({
      commands: [
        UrlRequest.match(request, {
          External: ({ href }) => LoadUrl({ href }),
          Internal: ({ url }) => PushUrl({ url: urlToString(url) }),
        }),
      ],
      model,
    }),
    ClickedLoadMore: () => {
      if (!Schema.is(JobsState.Loaded)(model.jobs)) {
        return { model };
      }

      return {
        commands: [
          FetchMoreJobs({
            generation: model.generation,
            query: queryOf(model.filters, model.jobs.jobs.length),
          }),
        ],
        model: modifyFields(model, { more: () => MoreState.Loading() }),
      };
    },
    ClickedMark: ({ job, kind }) =>
      shortlistWith(model, [
        {
          company: job.company,
          id: job.id,
          kind,
          location: job.location,
          title: job.title,
          url: job.url,
        },
        ...pipe(
          model.marks,
          Array.filter((mark) => mark.id !== job.id)
        ),
      ]),
    ClickedResetFilters: () =>
      navigatedTo(
        modifyFields(model, { draftSearch: () => "" }),
        defaultFilters
      ),
    ClickedRetry: () => withFilters(model, model.filters),
    ClickedRetryJob: () =>
      Schema.is(Route.Job)(model.route)
        ? enteredJob(model, model.route.id)
        : { model },
    CompletedNavigation: () => ({ model }),
    CompletedReadShortlist: ({ marks }) => ({
      model: modifyFields(model, { marks: () => marks }),
    }),
    CompletedWriteShortlist: () => ({ model }),
    FailedFetchJob: ({ id, message: failure }) => ({
      model: isAwaitingJob(model, id)
        ? modifyFields(model, {
            job: () => JobState.Failed({ id, message: failure }),
          })
        : model,
    }),
    FailedFetchJobs: ({ generation, message: failure }) => ({
      model:
        generation === model.generation
          ? modifyFields(model, {
              jobs: () => JobsState.Failed({ message: failure }),
            })
          : model,
    }),
    FailedFetchMoreJobs: ({ generation }) => ({
      model:
        generation === model.generation
          ? modifyFields(model, { more: () => MoreState.Failed() })
          : model,
    }),
    FailedFetchStats: () => ({ model }),
    SubmittedSearch: () =>
      navigatedTo(model, { ...model.filters, search: model.draftSearch }),
    SucceededFetchJob: ({ id, job }) => ({
      model: isAwaitingJob(model, id)
        ? modifyFields(model, {
            job: () =>
              Option.match(job, {
                onNone: () => JobState.Missing({ id }),
                onSome: (found) => JobState.Found({ job: found }),
              }),
          })
        : model,
    }),
    SucceededFetchJobs: ({ generation, page }) => ({
      model:
        generation === model.generation
          ? modifyFields(model, {
              jobs: () =>
                JobsState.Loaded({
                  generatedAt: page.generatedAt,
                  jobs: page.jobs,
                  total: page.total,
                }),
            })
          : model,
    }),
    SucceededFetchMoreJobs: ({ generation, page }) => {
      if (
        generation !== model.generation ||
        !Schema.is(JobsState.Loaded)(model.jobs)
      ) {
        return { model };
      }

      const known = model.jobs.jobs;

      const fresh = pipe(
        page.jobs,
        Array.filter(
          (job) =>
            !pipe(
              known,
              Array.some((seen) => seen.id === job.id)
            )
        )
      );

      return {
        model: modifyFields(model, {
          jobs: () =>
            JobsState.Loaded({
              generatedAt: page.generatedAt,
              jobs: [...known, ...fresh],
              total: page.total,
            }),
          more: () => MoreState.Idle(),
        }),
      };
    },
    SucceededFetchStats: ({ stats }) => ({
      model: modifyFields(model, { stats: () => StatsState.Loaded({ stats }) }),
    }),
    ToggledRegionGroup: ({ group }) =>
      navigatedTo(model, {
        ...model.filters,
        regionGroups: toggled(model.filters.regionGroups, group),
      }),
    ToggledRole: ({ role }) =>
      navigatedTo(model, {
        ...model.filters,
        roles: toggled(model.filters.roles, role),
      }),
    UpdatedDraftSearch: ({ value }) => ({
      model: modifyFields(model, { draftSearch: () => value }),
    }),
  });
