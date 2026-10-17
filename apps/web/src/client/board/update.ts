import { roleLevels } from "@rat-stack/core/contracts";
import { Array, Option, Schema, pipe } from "effect";
import { Command, Update } from "foldkit";
import { UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import type { Url } from "foldkit/url";

import type { AuthClient } from "../account/auth-client.js";
import type { MessageValue as AccountMessageValue } from "../account/message.js";
import type { ModelValue as AccountModelValue } from "../account/model.js";
import * as Account from "../account/update.js";
import { addressOf, boardUrl, Route, routeOfUrl } from "../route.js";
import type { RouteValue } from "../route.js";
import {
  FetchJob,
  FetchJobs,
  FetchMoreJobs,
  FetchStats,
  LoadUrl,
  PushUrl,
  ReadShortlist,
  ReplaceUrl,
  WriteShortlist,
} from "./command.js";
import {
  defaultFilters,
  Filters,
  hasNoSelection,
  queryOf,
  regionGroups,
  toggled,
} from "./filters.js";
import type { FiltersValue } from "./filters.js";
import { Message } from "./message.js";
import type { MessageValue } from "./message.js";
import { JobsState, JobState, MoreState, StatsState } from "./model.js";
import type { MarkedJobValue, ModelValue } from "./model.js";
import type { JobQueries } from "./queries.js";

type UpdateReturn = Update.Return<
  ModelValue,
  MessageValue,
  JobQueries | AuthClient
>;

const accountChild = {
  read: (model: ModelValue) => Option.some(model.account),
  toParentMessage: (message: AccountMessageValue) =>
    Message.GotAccountMessage({ message }),
  write: (model: ModelValue, account: AccountModelValue) =>
    modifyFields(model, { account: () => account }),
};

const foldAccount = Update.foldChild({
  ...accountChild,
  update: Account.update,
});

const foldAccountEntered = Update.foldChildStep({
  ...accountChild,
  update: Account.entered,
});

const sameFilters = Schema.toEquivalence(Filters);

const sameRoute = Schema.toEquivalence(Route);

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

const visiting = (
  step: UpdateReturn,
  visit: typeof PushUrl | typeof ReplaceUrl,
  url: string
): UpdateReturn => ({
  commands: [...(step.commands ?? []), visit({ url })],
  model: modifyFields(step.model, {
    awaitingEcho: (pending) => [...pending, url],
  }),
});

const navigatedTo = (model: ModelValue, filters: FiltersValue): UpdateReturn =>
  visiting(
    withFilters(model, filters),
    Schema.is(Route.Board)(model.route) && sameFilters(filters, model.filters)
      ? ReplaceUrl
      : PushUrl,
    boardUrl(filters)
  );

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
    Account: () => foldAccountEntered(routed),
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

const arrivedAt = (model: ModelValue, url: Url): UpdateReturn => {
  const route = routeOfUrl(url);
  const routed = entered(model, route);

  const address = addressOf(url);

  const canonical = Schema.is(Route.Board)(route)
    ? boardUrl(route.filters)
    : address;

  return canonical === address
    ? routed
    : visiting(routed, ReplaceUrl, canonical);
};

const echoed = (model: ModelValue, url: Url): UpdateReturn => {
  const address = addressOf(url);

  return Option.match(
    pipe(
      model.awaitingEcho,
      Array.findFirstIndex((sent) => sent === address)
    ),
    {
      onNone: () =>
        arrivedAt(modifyFields(model, { awaitingEcho: () => [] }), url),
      onSome: (index) => {
        const later = model.awaitingEcho.slice(index + 1);
        const settled = modifyFields(model, { awaitingEcho: () => later });

        return Array.isReadonlyArrayEmpty(later)
          ? arrivedAt(settled, url)
          : { model: settled };
      },
    }
  );
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
  const account = Account.init();

  const routed = arrivedAt(
    {
      account: account.model,
      awaitingEcho: [],
      draftSearch: "",
      filters: defaultFilters,
      generation: 0,
      job: JobState.NotAsked(),
      jobs: JobsState.NotAsked(),
      marks: [],
      more: MoreState.Idle(),
      route: routeOfUrl(url),
      stats: StatsState.Unavailable(),
    },
    url
  );

  return {
    commands: [
      ...(routed.commands ?? []),
      FetchStats(),
      ReadShortlist(),
      ...Command.mapMessages(account.commands, accountChild.toParentMessage),
    ],
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
    ChangedUrl: ({ url }) => echoed(model, url),
    ClickedClearMark: ({ id }) =>
      shortlistWith(
        model,
        pipe(
          model.marks,
          Array.filter((mark) => mark.id !== id)
        )
      ),
    ClickedLink: ({ request }) =>
      UrlRequest.match(request, {
        External: ({ href }) => ({ commands: [LoadUrl({ href })], model }),
        Internal: ({ url }) =>
          visiting(
            { model },
            sameRoute(routeOfUrl(url), model.route) ? ReplaceUrl : PushUrl,
            addressOf(url)
          ),
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
    GotAccountMessage: ({ message: accountMessage }) =>
      foldAccount(model, accountMessage),
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
        regionGroups: toggled(regionGroups, model.filters.regionGroups, group),
      }),
    ToggledRole: ({ role }) =>
      navigatedTo(model, {
        ...model.filters,
        roles: toggled(roleLevels, model.filters.roles, role),
      }),
    UpdatedDraftSearch: ({ value }) => ({
      model: modifyFields(model, { draftSearch: () => value }),
    }),
  });
