import { describe, expect, it } from "@effect/vitest";
import { Account, FREE, ProEntitlement } from "@rat-stack/core/contracts";
import type {
  JobDetailValue,
  MembershipValue,
} from "@rat-stack/core/contracts";
import { Effect, Option, Schema } from "effect";
import { renderToString } from "foldkit/experimental/server";

import { SessionState } from "../src/client/account/model.js";
import type { SessionStateValue } from "../src/client/account/model.js";
import { application } from "../src/client/application.js";
import { MembershipState } from "../src/client/billing/model.js";
import { Preload } from "../src/client/board/model.js";

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

const renderAs = (
  session: SessionStateValue,
  membership: Option.Option<MembershipValue>
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
          },
        };
      },
    },
    { flags: { origin: ORIGIN, preload }, url: `${ORIGIN}${PAGE}` }
  ).pipe(Effect.map(({ html }) => html));

const textOf = (html: string) =>
  html.replaceAll(/<[^>]+>/gu, " ").replaceAll(/\s+/gu, " ");

const TEASER =
  "Pro shows how long each role has been open, how often it was reposted, a 90-day hiring trend, and typical salary bands.";

describe("the company summary", () => {
  it.effect(
    "shows every viewer the summary and keeps each role's history out of the served HTML",
    () =>
      Effect.map(renderAs(SessionState.Checking(), Option.none()), (html) => {
        expect(textOf(html)).toContain(
          "3 open leadership roles. The longest has been listed for 45 days."
        );
        expect(html).not.toContain("daysOpen");
        expect(html).not.toContain("reposts");
      })
  );

  it.effect("offers Pro to signed-out viewers and Free members", () =>
    Effect.map(
      Effect.all([
        renderAs(SessionState.SignedOut(), Option.none()),
        renderAs(SessionState.SignedIn({ account: ada }), Option.some(free)),
      ]),
      (pages) => {
        for (const html of pages) {
          expect(textOf(html)).toContain(TEASER);
        }
      }
    )
  );

  it.effect("offers no upgrade to a Pro member", () =>
    Effect.map(
      renderAs(SessionState.SignedIn({ account: ada }), Option.some(pro)),
      (html) => {
        expect(textOf(html)).not.toContain(TEASER);
      }
    )
  );
});
