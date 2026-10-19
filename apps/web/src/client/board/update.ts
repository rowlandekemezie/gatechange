import { roleLevels } from "@rat-stack/core/contracts";
import { Array, Option, Schema, pipe } from "effect";
import { Command, Update } from "foldkit";
import { UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import type { Url } from "foldkit/url";

import type { AuthClient } from "../account/auth-client.js";
import type { MessageValue as AccountMessageValue } from "../account/message.js";
import { SessionState } from "../account/model.js";
import type { ModelValue as AccountModelValue } from "../account/model.js";
import * as Account from "../account/update.js";
import type { ListingRouteValue } from "../listing.js";
import { addressOf, boardUrl, Route, routeOfUrl } from "../route.js";
import type { RouteValue } from "../route.js";
import {
  FetchJob,
  FetchJobs,
  FetchListing,
  FetchMoreJobs,
  FetchStats,
  ImportStoredShortlist,
  ForgetSignInToken,
  LoadUrl,
  PushUrl,
  ReadShortlist,
  ReplaceUrl,
  SendTrackerChange,
  SyncTracker,
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
import {
  ImportOffer,
  JobsState,
  JobState,
  ListingState,
  MoreState,
  Preload,
  StatsState,
  TrackerChange,
  TrackerState,
} from "./model.js";
import type {
  FlagsValue,
  ImportOfferValue,
  MarkedJobValue,
  MarkKindValue,
  ModelValue,
  PreloadValue,
  RemoteTrackerValue,
  TrackerChangeValue,
} from "./model.js";
import type { JobQueries } from "./queries.js";
import {
  changedTracker,
  offerAfterFailure,
  offerAfterSync,
  trackRequestOf,
  unloadedTracker,
} from "./tracker.js";

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

const settledJobId = (model: ModelValue) =>
  JobState.match<Option.Option<string>>(model.job, {
    Failed: () => Option.none(),
    Found: ({ job }) => Option.some(job.id),
    Loading: () => Option.none(),
    Missing: ({ id }) => Option.some(id),
    NotAsked: () => Option.none(),
  });

const enteredJob = (model: ModelValue, id: string): UpdateReturn =>
  Option.contains(settledJobId(model), id)
    ? { model }
    : Option.match(listedJob(model, id), {
        onNone: () => ({
          commands: [FetchJob({ id })],
          model: modifyFields(model, { job: () => JobState.Loading({ id }) }),
        }),
        onSome: (job) => ({
          model: modifyFields(model, { job: () => JobState.Found({ job }) }),
        }),
      });

const listingRouteOf = (model: ModelValue) =>
  Schema.is(ListingState.NotAsked)(model.listing)
    ? Option.none()
    : Option.some(model.listing.route);

const enteredListing = (
  model: ModelValue,
  route: ListingRouteValue
): UpdateReturn =>
  Schema.is(ListingState.Loaded)(model.listing) &&
  sameRoute(model.listing.route, route)
    ? { model }
    : {
        commands: [FetchListing({ route })],
        model: modifyFields(model, {
          listing: () => ListingState.Loading({ route }),
        }),
      };

const isAwaitingListing = (model: ModelValue, route: ListingRouteValue) =>
  Schema.is(ListingState.Loading)(model.listing) &&
  Option.exists(listingRouteOf(model), (pending) => sameRoute(pending, route));

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
    Company: (company) => enteredListing(routed, company),
    ConfirmSignIn: () => ({ commands: [ForgetSignInToken()], model: routed }),
    Job: ({ id }) => enteredJob(routed, id),
    NotFound: () => ({ model: routed }),
    Role: (role) => enteredListing(routed, role),
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

const remoteOf = (model: ModelValue): Option.Option<RemoteTrackerValue> =>
  Schema.is(TrackerState.Remote)(model.tracker)
    ? Option.some(model.tracker)
    : Option.none();

const synced = (model: ModelValue): UpdateReturn => {
  const revision = model.trackerRevision + 1;

  return {
    commands: [SyncTracker({ revision })],
    model: modifyFields(model, { trackerRevision: () => revision }),
  };
};

const sentChange = (
  model: ModelValue,
  tracker: RemoteTrackerValue,
  change: TrackerChangeValue
): UpdateReturn => {
  const revision = model.trackerRevision + 1;

  return {
    commands: [SendTrackerChange({ change, revision })],
    model: modifyFields(model, {
      tracker: () =>
        changedTracker(
          TrackerState.Remote({ ...tracker, problem: Option.none() }),
          change
        ),
      trackerRevision: () => revision,
    }),
  };
};

const marked = (
  model: ModelValue,
  job: MarkedJobValue,
  kind: MarkKindValue
): UpdateReturn =>
  Option.match(remoteOf(model), {
    onNone: () =>
      shortlistWith(model, [
        { ...job, kind },
        ...pipe(
          model.marks,
          Array.filter((mark) => mark.id !== job.id)
        ),
      ]),
    onSome: (tracker) =>
      sentChange(
        model,
        tracker,
        TrackerChange.Track({ job: trackRequestOf(job, kind) })
      ),
  });

const unmarked = (model: ModelValue, id: string): UpdateReturn =>
  Option.match(remoteOf(model), {
    onNone: () =>
      shortlistWith(
        model,
        pipe(
          model.marks,
          Array.filter((mark) => mark.id !== id)
        )
      ),
    onSome: (tracker) =>
      sentChange(model, tracker, TrackerChange.Untrack({ jobId: id })),
  });

const withTrackedJob = (
  model: ModelValue,
  jobId: string,
  change: (
    tracker: RemoteTrackerValue,
    job: RemoteTrackerValue["jobs"][number]
  ) => UpdateReturn
): UpdateReturn =>
  pipe(
    remoteOf(model),
    Option.flatMap((tracker) =>
      pipe(
        Array.findFirst(tracker.jobs, (job) => job.jobId === jobId),
        Option.map((job) => change(tracker, job))
      )
    ),
    Option.getOrElse(() => ({ model }))
  );

const isCurrentRevision = (model: ModelValue, revision: number) =>
  revision === model.trackerRevision;

const withServerTracker = (
  model: ModelValue,
  revision: number,
  jobs: RemoteTrackerValue["jobs"]
): UpdateReturn => ({
  model: pipe(
    remoteOf(model),
    Option.filter(() => isCurrentRevision(model, revision)),
    Option.match({
      onNone: () => model,
      onSome: (tracker) =>
        modifyFields(model, {
          tracker: () =>
            TrackerState.Remote({ ...tracker, adding: [], jobs, loaded: true }),
        }),
    })
  ),
});

const withTrackerProblem = (model: ModelValue, message: string): ModelValue =>
  Option.match(remoteOf(model), {
    onNone: () => model,
    onSome: (tracker) =>
      modifyFields(model, {
        tracker: () =>
          TrackerState.Remote({ ...tracker, problem: Option.some(message) }),
      }),
  });

const withOffer = (
  model: ModelValue,
  next: (offer: ImportOfferValue) => ImportOfferValue
): ModelValue =>
  Option.match(remoteOf(model), {
    onNone: () => model,
    onSome: (tracker) =>
      modifyFields(model, {
        tracker: () =>
          TrackerState.Remote({ ...tracker, offer: next(tracker.offer) }),
      }),
  });

const movedShortlist = (model: ModelValue): UpdateReturn =>
  pipe(
    remoteOf(model),
    Option.map(({ offer }) => offer),
    Option.filter(Schema.is(ImportOffer.Asking)),
    Option.match({
      onNone: () => ({ model }),
      onSome: ({ count }) => {
        const revision = model.trackerRevision + 1;

        return {
          commands: [ImportStoredShortlist({ revision })],
          model: modifyFields(
            withOffer(model, () => ImportOffer.Moving({ count })),
            { trackerRevision: () => revision }
          ),
        };
      },
    })
  );

const followedSession = (step: UpdateReturn): UpdateReturn => {
  const { account, tracker } = step.model;
  const isLocal = Schema.is(TrackerState.Local)(tracker);

  if (Schema.is(SessionState.SignedIn)(account.session) && isLocal) {
    const sync = synced(
      modifyFields(step.model, { tracker: () => unloadedTracker })
    );

    return {
      commands: [...(step.commands ?? []), ...(sync.commands ?? [])],
      model: sync.model,
    };
  }

  if (Schema.is(SessionState.SignedOut)(account.session) && !isLocal) {
    return {
      commands: [...(step.commands ?? []), ReadShortlist()],
      model: modifyFields(step.model, {
        marks: () => [],
        tracker: () => TrackerState.Local(),
      }),
    };
  }

  return step;
};

export const routing = {
  onUrlChange: (url: Url) => Message.ChangedUrl({ url }),
  onUrlRequest: (request: UrlRequest) => Message.ClickedLink({ request }),
};

const preloaded = (model: ModelValue, preload: PreloadValue): ModelValue => {
  const { route } = model;

  return Preload.match<ModelValue>(preload, {
    Job: ({ job }) =>
      Schema.is(Route.Job)(route) && route.id === job.id
        ? modifyFields(model, { job: () => JobState.Found({ job }) })
        : model,
    JobMissing: () =>
      Schema.is(Route.Job)(route)
        ? modifyFields(model, { job: () => JobState.Missing({ id: route.id }) })
        : model,
    Listing: ({ generatedAt, jobs, total }) =>
      Schema.is(Route.Company)(route) || Schema.is(Route.Role)(route)
        ? modifyFields(model, {
            listing: () =>
              ListingState.Loaded({ generatedAt, jobs, route, total }),
          })
        : model,
    Nothing: () => model,
  });
};

export const init = (flags: FlagsValue, url: Url): UpdateReturn => {
  const account = Account.init();

  const routed = arrivedAt(
    preloaded(
      {
        account: account.model,
        awaitingEcho: [],
        draftSearch: "",
        filters: defaultFilters,
        generation: 0,
        job: JobState.NotAsked(),
        jobs: JobsState.NotAsked(),
        listing: ListingState.NotAsked(),
        marks: [],
        more: MoreState.Idle(),
        origin: flags.origin,
        route: routeOfUrl(url),
        stats: StatsState.Unavailable(),
        tracker: TrackerState.Local(),
        trackerRevision: 0,
      },
      flags.preload
    ),
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
    ChangedNotes: ({ jobId, notes }) =>
      withTrackedJob(model, jobId, (tracker, job) =>
        job.notes === notes
          ? { model }
          : sentChange(model, tracker, TrackerChange.Note({ jobId, notes }))
      ),
    ChangedSort: ({ sort }) => navigatedTo(model, { ...model.filters, sort }),
    ChangedStage: ({ jobId, stage }) =>
      withTrackedJob(model, jobId, (tracker, job) =>
        job.stage === stage
          ? { model }
          : sentChange(
              model,
              tracker,
              TrackerChange.Track({
                job: { jobId, snapshot: job.snapshot, stage },
              })
            )
      ),
    ChangedUrl: ({ url }) => echoed(model, url),
    ClickedClearMark: ({ id }) => unmarked(model, id),
    ClickedKeepShortlist: () => ({
      model: withOffer(model, (offer) =>
        Schema.is(ImportOffer.Asking)(offer) ? ImportOffer.Declined() : offer
      ),
    }),
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
      marked(
        model,
        {
          company: job.company,
          id: job.id,
          kind,
          location: job.location,
          title: job.title,
          url: job.url,
        },
        kind
      ),
    ClickedMoveShortlist: () => movedShortlist(model),
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
    ClickedRetryListing: () =>
      Schema.is(Route.Company)(model.route) ||
      Schema.is(Route.Role)(model.route)
        ? enteredListing(model, model.route)
        : { model },
    ClickedRetryTracker: () =>
      Option.match(remoteOf(model), {
        onNone: () => ({ model }),
        onSome: (tracker) =>
          synced(
            modifyFields(model, {
              tracker: () =>
                TrackerState.Remote({ ...tracker, problem: Option.none() }),
            })
          ),
      }),
    CompletedForgetSignInToken: () => ({ model }),
    CompletedNavigation: () => ({ model }),
    CompletedReadShortlist: ({ marks }) => ({
      model: modifyFields(model, { marks: () => marks }),
    }),
    CompletedSyncTracker: ({ jobs, revision, waiting }) => {
      const cleared = modifyFields(model, { marks: () => [] });

      return withServerTracker(
        isCurrentRevision(model, revision)
          ? withOffer(cleared, (offer) => offerAfterSync(offer, waiting))
          : cleared,
        revision,
        jobs
      );
    },
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
    FailedFetchListing: ({ message: failure, route }) => ({
      model: isAwaitingListing(model, route)
        ? modifyFields(model, {
            listing: () => ListingState.Failed({ message: failure, route }),
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
    FailedSyncTracker: ({ message: failure, revision }) => ({
      model: isCurrentRevision(model, revision)
        ? withOffer(withTrackerProblem(model, failure), offerAfterFailure)
        : model,
    }),
    FailedTrackerChange: ({ message: failure, revision }) => {
      const flagged = withTrackerProblem(model, failure);

      return isCurrentRevision(model, revision)
        ? synced(flagged)
        : { model: flagged };
    },
    GotAccountMessage: ({ message: accountMessage }) =>
      followedSession(foldAccount(model, accountMessage)),
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
    SucceededFetchListing: ({ listing, route }) => ({
      model: isAwaitingListing(model, route)
        ? modifyFields(model, {
            listing: () => ListingState.Loaded({ ...listing, route }),
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
    SucceededTrackerChange: ({ jobs, revision }) =>
      withServerTracker(model, revision, jobs),
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
