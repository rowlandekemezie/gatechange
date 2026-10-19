import { describe, expect, it } from "@effect/vitest";
import type { ListedJobValue } from "@rat-stack/core/contracts";
import { Array, Option, pipe, Schema } from "effect";
import { UrlRequest } from "foldkit/navigation";
import { fromString } from "foldkit/url";

import { defaultFilters } from "../src/client/board/filters.js";
import type { FiltersValue } from "../src/client/board/filters.js";
import { Message } from "../src/client/board/message.js";
import type { MessageValue } from "../src/client/board/message.js";
import { JobState, ListingState, Preload } from "../src/client/board/model.js";
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
  title: "Engineering Manager",
  url: "https://himalayas.app/companies/moniepoint/jobs/engineering-manager-9245044553",
};

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
