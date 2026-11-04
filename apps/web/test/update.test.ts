import { describe, expect, it } from "@effect/vitest";
import type { ListedJobValue } from "@rat-stack/core/contracts";
import { Array, Option, pipe, Schema } from "effect";
import { UrlRequest } from "foldkit/navigation";
import { fromString } from "foldkit/url";

import { defaultFilters } from "../src/client/board/filters.js";
import type { FiltersValue } from "../src/client/board/filters.js";
import { Message } from "../src/client/board/message.js";
import type { MessageValue } from "../src/client/board/message.js";
import {
  JobsState,
  JobState,
  ListingState,
  Preload,
} from "../src/client/board/model.js";
import type { PreloadValue, ModelValue } from "../src/client/board/model.js";
import { init, update } from "../src/client/board/update.js";
import { boardUrl, jobRouter, Route } from "../src/client/route.js";

const ORIGIN = "https://jobs.example";

const urlAt = (path: string) =>
  Option.getOrThrow(fromString(`${ORIGIN}${path}`));

interface Step {
  readonly commands: readonly {
    readonly name: string;
    readonly args?: unknown;
  }[];
  readonly model: ModelValue;
}

const started = (
  path: string,
  preload: PreloadValue = Preload.Nothing()
): Step => {
  const { commands = [], model } = init(
    { origin: ORIGIN, preload },
    urlAt(path)
  );

  return { commands, model };
};

const sent = (step: Step, message: MessageValue): Step => {
  const { commands = [], model } = update(step.model, message);

  return { commands, model };
};

const sentAll = (step: Step, messages: readonly MessageValue[]): Step => {
  let current = step;

  for (const message of messages) {
    current = sent(current, message);
  }

  return current;
};

const named = (step: Step, name: string) =>
  pipe(
    step.commands,
    Array.filter((command) => command.name === name)
  );

const urlChange = (path: string) => Message.ChangedUrl({ url: urlAt(path) });

const directorOnly: FiltersValue = { ...defaultFilters, roles: ["Director"] };

const listed: ListedJobValue = {
  arrangement: "Remote",
  company: "Moniepoint",
  daysOpen: 0,
  enrichment: null,
  feed: "himalayas:engineering-manager",
  firstSeenAt: 1_760_000_000_000,
  id: "himalayas:https://himalayas.app/companies/moniepoint/jobs/engineering-manager-9245044553",
  lastSeenAt: 1_760_000_000_000,
  location: "Remote, Canada",
  postedAt: 1_760_000_000_000,
  region: "RemoteCanada",
  relevance: 12,
  reposts: 0,
  role: "EngineeringManager",
  salary: null,
  source: "Himalayas",
  status: "on_time",
  title: "Engineering Manager",
  url: "https://himalayas.app/companies/moniepoint/jobs/engineering-manager-9245044553",
};

const stats = {
  activeJobs: 1,
  companies: [],
  feedsFailing: 0,
  feedsTotal: 1,
  generatedAt: 1_760_000_000_000,
  lastRun: null,
  newToday: 0,
  placements: [],
  regions: [],
  roles: [],
};

describe("board stats", () => {
  it("uses the preloaded stats without asking the backend", () => {
    const opened = started(
      "/",
      Preload.Board({
        filters: defaultFilters,
        generatedAt: 1_760_000_000_000,
        jobs: [],
        stats,
        total: 0,
      })
    );

    expect(named(opened, "FetchStats")).toHaveLength(0);
  });

  it("asks the backend on the board when the preload has no stats", () => {
    expect(named(started("/"), "FetchStats")).toHaveLength(1);
  });

  it("waits until the visitor reaches the board", () => {
    const opened = started(jobRouter({ id: listed.id }));

    expect(named(opened, "FetchStats")).toHaveLength(0);
    expect(named(sent(opened, urlChange("/")), "FetchStats")).toHaveLength(1);
  });

  it("does not ask again once stats have loaded", () => {
    const loaded = sent(started("/"), Message.SucceededFetchStats({ stats }));

    expect(
      named(sent(loaded, urlChange("/?sort=newest")), "FetchStats")
    ).toHaveLength(0);
  });
});

describe("URL-driven board state", () => {
  it("refetches only when the URL's filters differ from the Model's", () => {
    const opened = started(boardUrl(directorOnly));
    expect(named(opened, "FetchJobs")).toHaveLength(1);

    const same = sent(opened, urlChange(boardUrl(directorOnly)));
    expect(named(same, "FetchJobs")).toHaveLength(0);
    expect(same.model.generation).toBe(opened.model.generation);

    const other = sent(same, urlChange("/?sort=newest"));
    expect(named(other, "FetchJobs")).toHaveLength(1);
    expect(other.model.filters).toStrictEqual({
      ...defaultFilters,
      sort: "Newest",
    });
  });

  it("back and forward restore the filters of each history entry", () => {
    const first = sent(started("/"), Message.ToggledRole({ role: "Director" }));
    const firstUrl = boardUrl(first.model.filters);

    const second = sentAll(first, [
      urlChange(firstUrl),
      Message.ChangedSort({ sort: "Newest" }),
    ]);

    const secondUrl = boardUrl(second.model.filters);
    const settled = sent(second, urlChange(secondUrl));

    const back = sent(settled, urlChange(firstUrl));
    expect(back.model.filters).toStrictEqual(first.model.filters);

    const backToStart = sent(back, urlChange("/"));
    expect(backToStart.model.filters).toStrictEqual(defaultFilters);

    const forward = sent(backToStart, urlChange(firstUrl));
    expect(forward.model.filters).toStrictEqual(first.model.filters);
  });

  it("drops a job list response from an earlier generation", () => {
    const step = sentAll(started("/"), [
      Message.ToggledRole({ role: "Director" }),
      Message.ChangedSort({ sort: "Newest" }),
    ]);

    const stale = sent(
      step,
      Message.SucceededFetchJobs({
        generation: step.model.generation - 1,
        page: { generatedAt: 1, jobs: [listed], total: 1 },
      })
    );

    expect(stale.model.jobs._tag).toBe("Loading");
  });

  describe("changing filters with roles on screen", () => {
    const page = { generatedAt: 1, jobs: [listed], total: 1 };

    const refreshing = () =>
      sentAll(started("/"), [
        Message.SucceededFetchJobs({
          generation: started("/").model.generation,
          page,
        }),
        Message.ChangedSort({ sort: "Newest" }),
      ]);

    it("keeps the current roles until the new ones arrive", () => {
      expect(refreshing().model.jobs).toStrictEqual(JobsState.Refreshing(page));
    });

    it("keeps them through a second change", () => {
      const step = sent(
        refreshing(),
        Message.ToggledRole({ role: "Director" })
      );

      expect(step.model.jobs).toStrictEqual(JobsState.Refreshing(page));
    });

    it("replaces them with the newest response only", () => {
      const before = refreshing();

      const stale = sent(
        before,
        Message.SucceededFetchJobs({
          generation: before.model.generation - 1,
          page: { generatedAt: 2, jobs: [], total: 0 },
        })
      );

      expect(stale.model.jobs).toStrictEqual(JobsState.Refreshing(page));

      const fresh = sent(
        before,
        Message.SucceededFetchJobs({
          generation: before.model.generation,
          page: { generatedAt: 2, jobs: [], total: 0 },
        })
      );

      expect(fresh.model.jobs).toStrictEqual(
        JobsState.Loaded({ generatedAt: 2, jobs: [], total: 0 })
      );
    });

    it("shows the failure when the refresh fails", () => {
      const before = refreshing();

      const failed = sent(
        before,
        Message.FailedFetchJobs({
          generation: before.model.generation,
          message: "down",
        })
      );

      expect(failed.model.jobs._tag).toBe("Failed");
    });

    it("does not load more while refreshing", () => {
      const step = sent(refreshing(), Message.ClickedLoadMore());

      expect(step.commands ?? []).toStrictEqual([]);
    });
  });

  it("drops a job detail response for a job the reader already left", () => {
    const other = "greenhouse:stripe:7023114";

    const step = sentAll(started(jobRouter({ id: listed.id })), [
      urlChange(jobRouter({ id: other })),
      Message.SucceededFetchJob({ id: listed.id, job: Option.some(listed) }),
    ]);

    expect(step.model.job).toStrictEqual(JobState.Loading({ id: other }));
  });

  it("a late URL change from an earlier click does not roll the chips or search back", () => {
    const step = sentAll(started("/"), [
      Message.ToggledRole({ role: "Director" }),
      Message.UpdatedDraftSearch({ value: "platform" }),
      Message.SubmittedSearch(),
    ]);

    const firstUrl = boardUrl({
      ...defaultFilters,
      roles: pipe(
        defaultFilters.roles,
        Array.filter((role) => role !== "Director")
      ),
    });

    const latest = step.model;

    const late = sent(step, urlChange(firstUrl));
    expect(late.model.filters).toStrictEqual(latest.filters);
    expect(late.model.draftSearch).toBe("platform");
    expect(named(late, "FetchJobs")).toHaveLength(0);

    const caughtUp = sentAll(late, [urlChange(boardUrl(latest.filters))]);

    expect(caughtUp.model.filters).toStrictEqual(latest.filters);
    expect(named(caughtUp, "FetchJobs")).toHaveLength(0);
  });

  it("rewrites a non-canonical board URL in place", () => {
    const opened = started("/?role=director,director&utm_source=x");

    expect(named(opened, "ReplaceUrl")).toStrictEqual([
      expect.objectContaining({ args: { url: boardUrl(directorOnly) } }),
    ]);
    expect(named(started(boardUrl(directorOnly)), "ReplaceUrl")).toHaveLength(
      0
    );
  });

  it("a link to the current page replaces the history entry instead of pushing one", () => {
    const opened = started("/shortlist");

    const clicked = sent(
      opened,
      Message.ClickedLink({
        request: UrlRequest.Internal({ url: urlAt("/shortlist") }),
      })
    );

    expect(named(clicked, "ReplaceUrl")).toHaveLength(1);
    expect(named(clicked, "PushUrl")).toHaveLength(0);

    const elsewhere = sent(
      opened,
      Message.ClickedLink({ request: UrlRequest.Internal({ url: urlAt("/") }) })
    );

    expect(named(elsewhere, "PushUrl")).toHaveLength(1);
  });

  it("a link to another page lands at the top while Back and same-page links keep the scroll", () => {
    const clicked = sent(
      started("/"),
      Message.ClickedLink({
        request: UrlRequest.Internal({ url: urlAt("/jobs/abc") }),
      })
    );

    expect(named(clicked, "ScrollToTop")).toHaveLength(0);

    const landed = sent(clicked, urlChange("/jobs/abc"));

    expect(named(landed, "ScrollToTop")).toHaveLength(1);
    expect(named(sent(landed, urlChange("/")), "ScrollToTop")).toHaveLength(0);

    const resorted = sentAll(started("/"), [
      Message.ClickedLink({
        request: UrlRequest.Internal({ url: urlAt("/?sort=newest") }),
      }),
      urlChange("/?sort=newest"),
    ]);

    expect(named(resorted, "ScrollToTop")).toHaveLength(0);
  });

  it("a link to a fragment scrolls to it once the page lands", () => {
    const clicked = sent(
      started("/shortlist"),
      Message.ClickedLink({
        request: UrlRequest.Internal({ url: urlAt("/#agents") }),
      })
    );

    expect(named(clicked, "PushUrl")).toStrictEqual([
      expect.objectContaining({ args: { url: "/#agents" } }),
    ]);

    const landed = sent(clicked, urlChange("/#agents"));

    expect(named(landed, "ScrollToFragment")).toStrictEqual([
      expect.objectContaining({ args: { fragment: "agents" } }),
    ]);
    expect(named(landed, "ScrollToTop")).toHaveLength(0);
    expect(
      named(
        sentAll(started("/"), [
          Message.ClickedLink({
            request: UrlRequest.Internal({ url: urlAt("/shortlist") }),
          }),
          urlChange("/shortlist"),
        ]),
        "ScrollToFragment"
      )
    ).toHaveLength(0);
  });

  it("opens the salary and seniority filters for a link that sets them and remembers a toggle", () => {
    expect(started("/").model.proFiltersOpen).toBe(false);
    expect(started("/?pay=200000").model.proFiltersOpen).toBe(true);

    const opened = sent(
      started("/"),
      Message.ToggledProFilters({ isOpen: true })
    );

    expect(
      sent(opened, Message.UpdatedDraftSearch({ value: "vp" })).model
        .proFiltersOpen
    ).toBe(true);
  });

  it("toggles the filter panel, and opens it for a link with Pro filters", () => {
    expect(started("/").model.filtersOpen).toBe(false);
    expect(started("/?pay=200000").model.filtersOpen).toBe(true);

    const opened = sent(started("/"), Message.ClickedFilters());

    expect(opened.model.filtersOpen).toBe(true);
    expect(sent(opened, Message.ClickedFilters()).model.filtersOpen).toBe(
      false
    );
  });

  it("submitting an unchanged search replaces the history entry", () => {
    const opened = started(boardUrl(directorOnly));

    const resubmitted = sent(opened, Message.SubmittedSearch());
    expect(named(resubmitted, "ReplaceUrl")).toHaveLength(1);
    expect(named(resubmitted, "PushUrl")).toHaveLength(0);

    const changed = sentAll(opened, [
      Message.UpdatedDraftSearch({ value: "staff" }),
      Message.SubmittedSearch(),
    ]);

    expect(named(changed, "PushUrl")).toHaveLength(1);
  });
});

const lastQuery = (step: Step) =>
  pipe(named(step, "FetchJobs"), Array.last, Option.getOrThrow);

describe("board pages", () => {
  it("asks for 15 roles first and 25 more on each load", () => {
    const opened = started("/");

    expect(named(opened, "FetchJobs")).toHaveLength(1);
    expect(lastQuery(opened).args).toMatchObject({
      query: { limit: 15, offset: 0 },
    });

    const loaded = sent(
      opened,
      Message.SucceededFetchJobs({
        generation: opened.model.generation,
        page: {
          generatedAt: 0,
          jobs: Array.makeBy(15, (index) => ({
            ...listed,
            id: `job-${index}`,
          })),
          total: 60,
        },
      })
    );

    const more = named(
      sent(loaded, Message.ClickedLoadMore()),
      "FetchMoreJobs"
    );

    expect(more).toHaveLength(1);
    expect(more[0]?.args).toMatchObject({ query: { limit: 25, offset: 15 } });
  });
});

describe("pay and level filters", () => {
  it("a pay floor keeps the chosen currency and reaches the job query and URL", () => {
    const step = sentAll(started("/"), [
      Message.ChangedPayFloor({ amount: 200_000 }),
      Message.ChangedPayCurrency({ currency: "CAD" }),
      Message.ChangedPayFloor({ amount: 300_000 }),
    ]);

    const floor = { amount: 300_000, currency: "CAD" };

    expect(step.model.filters.salaryFloor).toStrictEqual(floor);
    expect(lastQuery(step).args).toMatchObject({
      query: { salaryFloor: floor, seniorities: [] },
    });
    expect(named(step, "PushUrl")).toStrictEqual([
      expect.objectContaining({
        args: { url: "/?currency=cad&pay=300000" },
      }),
    ]);
  });

  it("a currency change without a pay floor fetches nothing and keeps the filters", () => {
    const step = sent(
      started("/"),
      Message.ChangedPayCurrency({ currency: "EUR" })
    );

    expect(step.commands).toStrictEqual([]);
    expect(step.model.filters).toStrictEqual(defaultFilters);
  });

  it("any pay clears the floor back to the default board", () => {
    const step = sent(
      started("/?pay=250000&currency=gbp"),
      Message.ChangedPayFloor({ amount: null })
    );

    expect(step.model.filters).toStrictEqual(defaultFilters);
    expect(lastQuery(step).args).toMatchObject({
      query: { salaryFloor: null },
    });
    expect(named(step, "PushUrl")).toStrictEqual([
      expect.objectContaining({ args: { url: "/" } }),
    ]);
  });

  it("levels toggle into canonical order and any level clears them", () => {
    const picked = sentAll(started("/"), [
      Message.ToggledSeniority({ seniority: "Director" }),
      Message.ToggledSeniority({ seniority: "Manager" }),
    ]);

    expect(picked.model.filters.seniorities).toStrictEqual([
      "Manager",
      "Director",
    ]);
    expect(lastQuery(picked).args).toMatchObject({
      query: { seniorities: ["Manager", "Director"] },
    });

    const cleared = sent(picked, Message.ClickedAnySeniority());

    expect(cleared.model.filters).toStrictEqual(defaultFilters);
    expect(lastQuery(cleared).args).toMatchObject({
      query: { seniorities: [] },
    });
  });
});

describe("server-rendered pages", () => {
  const ROLE_PATH = "/roles/engineering-manager/remote-canada";

  it("boots a hydrated job page from its preload without fetching the job again", () => {
    const step = started(
      jobRouter({ id: listed.id }),
      Preload.Job({ job: listed })
    );

    expect(named(step, "FetchJob")).toEqual([]);
    expect(step.model.job).toStrictEqual(JobState.Found({ job: listed }));
  });

  it("boots a hydrated pruned job page as missing", () => {
    const step = started(jobRouter({ id: listed.id }), Preload.JobMissing());

    expect(named(step, "FetchJob")).toEqual([]);
    expect(step.model.job).toStrictEqual(JobState.Missing({ id: listed.id }));
  });

  it("boots a hydrated role page from its preload without fetching", () => {
    const step = started(
      ROLE_PATH,
      Preload.Listing({
        generatedAt: 1_760_000_000_000,
        jobs: [listed],
        summary: null,
        total: 1,
      })
    );

    expect(named(step, "FetchListing")).toEqual([]);
    expect(Schema.is(ListingState.Loaded)(step.model.listing)).toBe(true);
  });

  it("a client visit to a role page fetches it, and drops a reply for a page already left", () => {
    const opened = sent(started("/"), urlChange(ROLE_PATH));

    const route = Route.Role({
      place: "RemoteCanada",
      role: "EngineeringManager",
    });

    expect(named(opened, "FetchListing")).toHaveLength(1);

    const left = sent(opened, urlChange("/companies/moniepoint"));

    const late = sent(
      left,
      Message.SucceededFetchListing({
        listing: { generatedAt: 1, jobs: [listed], summary: null, total: 1 },
        route,
      })
    );

    expect(late.model.listing).toStrictEqual(
      ListingState.Loading({ route: Route.Company({ slug: "moniepoint" }) })
    );
  });
});
