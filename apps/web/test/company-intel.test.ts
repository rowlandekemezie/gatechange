import { describe, expect, it } from "@effect/vitest";
import {
  Account,
  FREE,
  ProEntitlement,
  ShownTrend,
  ThinTrend,
} from "@rat-stack/core/contracts";
import type {
  CompanyIntelValue,
  JobDetailValue,
  MembershipValue,
} from "@rat-stack/core/contracts";
import { Array, Effect, Option, pipe, Schema } from "effect";
import { renderToString } from "foldkit/experimental/server";
import { fromString } from "foldkit/url";

import { SessionState } from "../src/client/account/model.js";
import type { SessionStateValue } from "../src/client/account/model.js";
import { application } from "../src/client/application.js";
import { Message as BillingMessage } from "../src/client/billing/message.js";
import { MembershipState } from "../src/client/billing/model.js";
import { Message } from "../src/client/board/message.js";
import type { MessageValue } from "../src/client/board/message.js";
import { IntelState, Preload } from "../src/client/board/model.js";
import type { IntelStateValue, ModelValue } from "../src/client/board/model.js";
import { init, update } from "../src/client/board/update.js";

const ORIGIN = "https://jobs.example";

const PAGE = "/companies/acme-cloud";

const DAY = 86_400_000;

const NOW = 1_790_000_000_000;

const ada = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

const free: MembershipValue = { entitlement: FREE, instantAlerts: false };

const pro: MembershipValue = {
  entitlement: ProEntitlement.make({
    periodEnd: NOW + 30 * DAY,
    plan: "Monthly",
    renews: true,
  }),
  instantAlerts: false,
};

const job: JobDetailValue = {
  arrangement: "Remote",
  company: "Acme Cloud",
  enrichment: null,
  feed: "greenhouse:acme-cloud",
  firstSeenAt: NOW - 45 * DAY,
  id: "greenhouse:acme-cloud/vp",
  lastSeenAt: NOW,
  location: "Remote - Canada",
  postedAt: NOW - 45 * DAY,
  region: "RemoteCanada",
  relevance: 60,
  role: "VicePresident",
  salary: null,
  source: "Greenhouse",
  title: "VP Engineering",
  url: "https://boards.example/acme-cloud/vp",
};

const preload = Preload.Listing({
  generatedAt: NOW,
  jobs: [job],
  summary: { longestOpenDays: 45, openRoles: 3 },
  total: 3,
});

const intel: CompanyIntelValue = {
  bands: [{ currency: "USD", max: 310_000, min: 260_000, roles: 2 }],
  roles: [
    {
      daysOpen: 45,
      id: job.id,
      reposts: 2,
      role: "VicePresident",
      title: "VP Engineering",
    },
  ],
  trackedSince: NOW - 100 * DAY,
  trend: ShownTrend.make({
    weeks: [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 3].map((open, index) => ({
      open,
      weekEnding: NOW - (12 - index) * 7 * DAY,
    })),
  }),
};

const renderAs = (
  session: SessionStateValue,
  membership: Option.Option<MembershipValue>,
  intelState: IntelStateValue
) =>
  renderToString(
    {
      ...application,
      init: (...args: Parameters<typeof application.init>) => {
        const started = application.init(...args);

        return {
          ...started,
          model: {
            ...started.model,
            account: { ...started.model.account, session },
            billing: {
              ...started.model.billing,
              membership: Option.match(membership, {
                onNone: () => started.model.billing.membership,
                onSome: (found) =>
                  MembershipState.Loaded({ membership: found }),
              }),
            },
            intel: intelState,
          },
        };
      },
    },
    { flags: { origin: ORIGIN, preload }, url: `${ORIGIN}${PAGE}` }
  ).pipe(Effect.map(({ html }) => html));

const textOf = (html: string) =>
  html.replaceAll(/<[^>]+>/gu, " ").replaceAll(/\s+/gu, " ");

const PRO_DETAIL = [
  "How long each role has been open",
  "reposted 2 times",
  "Open leadership roles went from",
  "Typical salary bands",
  "USD 260k to 310k",
];

describe("company intel on a company page", () => {
  it.effect(
    "shows every viewer the summary and keeps Pro detail out of the served HTML",
    () =>
      Effect.map(
        renderAs(SessionState.Checking(), Option.none(), IntelState.NotAsked()),
        (html) => {
          const text = textOf(html);

          expect(text).toContain(
            "3 open leadership roles. The longest has been listed for 45 days."
          );

          for (const detail of PRO_DETAIL) {
            expect(text).not.toContain(detail);
          }

          expect(html).not.toContain("daysOpen");
          expect(html).not.toContain("reposts");
        }
      )
  );

  it.effect("offers Pro to a Free member instead of the detail", () =>
    Effect.map(
      renderAs(
        SessionState.SignedIn({ account: ada }),
        Option.some(free),
        IntelState.Loaded({ intel, slug: "acme-cloud" })
      ),
      (html) => {
        const text = textOf(html);

        expect(text).toContain(
          "Pro shows how long each role has been open, how often it was reposted, a 90-day hiring trend, and typical salary bands."
        );

        for (const detail of PRO_DETAIL) {
          expect(text).not.toContain(detail);
        }
      }
    )
  );

  it.effect(
    "shows a Pro member days open, reposts, a labelled trend chart with a text summary, bands, and the source note",
    () =>
      Effect.map(
        renderAs(
          SessionState.SignedIn({ account: ada }),
          Option.some(pro),
          IntelState.Loaded({ intel, slug: "acme-cloud" })
        ),
        (html) => {
          const text = textOf(html);

          expect(text).toContain(
            "VP Engineering Open 45 days, reposted 2 times"
          );
          expect(html).toContain("<svg");
          expect(text).toContain("Open roles");
          expect(text).toContain("Week ending");
          expect(text).toContain("This week");
          expect(text).toContain(
            "Open leadership roles went from 0 in the week ending"
          );
          expect(text).toContain(
            "to 3 this week, with a peak of 3, over 13 weeks."
          );
          expect(text).toContain("USD 260k to 310k, from 2 stated bands");
          expect(text).toContain(
            "Remotive and Hacker News roles are left out under their terms."
          );
          expect(text).not.toContain("Pro shows how long");
        }
      )
  );

  it.effect("draws no chart when the history is too thin for a trend", () =>
    Effect.map(
      renderAs(
        SessionState.SignedIn({ account: ada }),
        Option.some(pro),
        IntelState.Loaded({
          intel: { ...intel, trend: ThinTrend.make({ roles: 1, weeks: 13 }) },
          slug: "acme-cloud",
        })
      ),
      (html) => {
        expect(html).not.toContain("<svg");
        expect(textOf(html)).toContain(
          "Not enough history for a trend yet. A trend needs at least 3 roles over 4 weeks, and this company has 1 role over 13 weeks."
        );
      }
    )
  );
});

interface Step {
  readonly commands: readonly {
    readonly name: string;
    readonly args?: unknown;
  }[];
  readonly model: ModelValue;
}

const urlAt = (path: string) =>
  Option.getOrThrow(fromString(`${ORIGIN}${path}`));

const started = (path: string): Step => {
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

const intelFetches = (step: Step) =>
  pipe(
    step.commands,
    Array.filter((command) => command.name === "FetchCompanyIntel")
  );

const membershipLoaded = (membership: MembershipValue) =>
  Message.GotBillingMessage({
    message: BillingMessage.CompletedFetchMembership({
      membership: Option.some(membership),
    }),
  });

describe("fetching company intel", () => {
  it("fetches once a Pro membership loads on a company page, and only once", () => {
    const loaded = sent(started(PAGE), membershipLoaded(pro));

    expect(intelFetches(loaded)).toStrictEqual([
      expect.objectContaining({ args: { slug: "acme-cloud" } }),
    ]);
    expect(loaded.model.intel).toStrictEqual(
      IntelState.Loading({ slug: "acme-cloud" })
    );
    expect(intelFetches(sent(loaded, membershipLoaded(pro)))).toStrictEqual([]);
  });

  it("never fetches for a Free member", () => {
    const loaded = sent(started(PAGE), membershipLoaded(free));

    expect(intelFetches(loaded)).toStrictEqual([]);
    expect(loaded.model.intel).toStrictEqual(IntelState.NotAsked());
  });

  it("keeps the answer for the company asked about and drops a late one", () => {
    const loading = sent(started(PAGE), membershipLoaded(pro));

    expect(
      sent(loading, Message.SucceededFetchIntel({ intel, slug: "acme-cloud" }))
        .model.intel
    ).toStrictEqual(IntelState.Loaded({ intel, slug: "acme-cloud" }));
    expect(
      sent(loading, Message.SucceededFetchIntel({ intel, slug: "other-co" }))
        .model.intel
    ).toStrictEqual(IntelState.Loading({ slug: "acme-cloud" }));
  });

  it("locks the detail when the server says Pro ended, and retries a failure once asked", () => {
    const loading = sent(started(PAGE), membershipLoaded(pro));

    expect(
      sent(
        loading,
        Message.FailedFetchIntel({ locked: true, slug: "acme-cloud" })
      ).model.intel
    ).toStrictEqual(IntelState.Locked({ slug: "acme-cloud" }));

    const failed = sent(
      loading,
      Message.FailedFetchIntel({ locked: false, slug: "acme-cloud" })
    );

    expect(failed.model.intel).toStrictEqual(
      IntelState.Failed({ slug: "acme-cloud" })
    );
    expect(intelFetches(failed)).toStrictEqual([]);
    expect(
      intelFetches(sent(failed, Message.ClickedRetryIntel()))
    ).toHaveLength(1);
  });
});
