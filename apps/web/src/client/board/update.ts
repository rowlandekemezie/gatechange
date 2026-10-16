import { Array, Schema, pipe } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import {
  FetchJobs,
  FetchMoreJobs,
  FetchStats,
  ReadShortlist,
  WriteShortlist,
} from "./command.js";
import { defaultFilters, hasNoSelection, queryOf, toggled } from "./filters.js";
import type { FiltersValue } from "./filters.js";
import { Message } from "./message.js";
import type { MessageValue } from "./message.js";
import { initialModel, JobsState, MoreState, StatsState } from "./model.js";
import type { MarkedJobValue, ModelValue } from "./model.js";
import type { JobQueries } from "./queries.js";

type UpdateReturn = Update.Return<ModelValue, MessageValue, JobQueries>;

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

const shortlistWith = (
  model: ModelValue,
  marks: readonly MarkedJobValue[]
): UpdateReturn => ({
  commands: [WriteShortlist({ marks })],
  model: modifyFields(model, { marks: () => marks }),
});

export const init = (): UpdateReturn => ({
  commands: [
    FetchJobs({
      generation: initialModel.generation,
      query: queryOf(initialModel.filters, 0),
    }),
    FetchStats(),
    ReadShortlist(),
  ],
  model: initialModel,
});

export const update = (
  model: ModelValue,
  message: MessageValue
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ChangedAge: ({ maxAgeDays }) =>
      withFilters(model, { ...model.filters, maxAgeDays }),
    ChangedSort: ({ sort }) => withFilters(model, { ...model.filters, sort }),
    ChangedView: ({ view }) => ({
      model: modifyFields(model, { view: () => view }),
    }),
    ClickedClearMark: ({ id }) =>
      shortlistWith(
        model,
        pipe(
          model.marks,
          Array.filter((mark) => mark.id !== id)
        )
      ),
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
      withFilters(
        modifyFields(model, { draftSearch: () => "" }),
        defaultFilters
      ),
    ClickedRetry: () => withFilters(model, model.filters),
    CompletedReadShortlist: ({ marks }) => ({
      model: modifyFields(model, { marks: () => marks }),
    }),
    CompletedWriteShortlist: () => ({ model }),
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
      withFilters(model, { ...model.filters, search: model.draftSearch }),
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
      withFilters(model, {
        ...model.filters,
        regionGroups: toggled(model.filters.regionGroups, group),
      }),
    ToggledRole: ({ role }) =>
      withFilters(model, {
        ...model.filters,
        roles: toggled(model.filters.roles, role),
      }),
    UpdatedDraftSearch: ({ value }) => ({
      model: modifyFields(model, { draftSearch: () => value }),
    }),
  });
