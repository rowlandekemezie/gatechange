import { describe, expect, it } from "@effect/vitest";
import { Account, FREE, ProEntitlement } from "@rat-stack/core/contracts";
import type {
  ListedJobValue,
  MembershipValue,
} from "@rat-stack/core/contracts";
import { Effect, Option, Schema } from "effect";
import { renderToString } from "foldkit/experimental/server";

import { SessionState } from "../src/client/account/model.js";
import { application } from "../src/client/application.js";
import { MembershipState } from "../src/client/billing/model.js";
import { JobsState, Preload } from "../src/client/board/model.js";

const ORIGIN = "https://jobs.example";

const account = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

const free: MembershipValue = { entitlement: FREE, instantAlerts: false };

const pro: MembershipValue = {
  entitlement: ProEntitlement.make({
    periodEnd: Date.UTC(2026, 10, 18),
    plan: "Monthly",
    renews: true,
  }),
  instantAlerts: false,
};

const job = (id: string, salary: string | null): ListedJobValue => ({
  arrangement: "Remote",
  company: "Acme",
  daysOpen: 0,
  enrichment: null,
  feed: "Greenhouse:acme",
  firstSeenAt: 1_760_000_000_000,
  id,
  lastSeenAt: 1_760_500_000_000,
  location: "Remote, Canada",
  postedAt: 1_760_000_000_000,
  region: "RemoteCanada",
  relevance: 10,
  reposts: 0,
  role: "Director",
  salary,
  source: "Greenhouse",
  status: "on_time",
  title: `Director of Engineering ${id}`,
  url: `https://boards.example/${id}`,
});

const renderAs = (
  path: string,
  session: typeof SessionState.Type,
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
                onSome: (value) =>
                  MembershipState.Loaded({ membership: value }),
              }),
            },
            jobs: JobsState.Loaded({
              generatedAt: 1_760_500_000_000,
              jobs: [job("with-pay", "$200k"), job("without-pay", null)],
              total: 2,
            }),
          },
        };
      },
    },
    {
      flags: { origin: ORIGIN, preload: Preload.Nothing() },
      url: ORIGIN + path,
    }
  ).pipe(Effect.map(({ html }) => html));

const groupOf = (html: string) =>
  /<fieldset[^>]*class="pro-refinements"[^>]*>(?<group>.*?)<\/fieldset>/su.exec(
    html
  )?.groups?.group ?? "";

describe("paid board refinements", () => {
  it.effect.each(["anonymous", "Free"])(
    "explains the restriction before %s viewers select a control",
    (viewer) =>
      Effect.map(
        renderAs(
          "/",
          viewer === "anonymous"
            ? SessionState.SignedOut()
            : SessionState.SignedIn({ account }),
          viewer === "anonymous"
            ? Option.none<MembershipValue>()
            : Option.some(free)
        ),
        (html) => {
          const group = groupOf(html);

          expect(group).toContain("Salary and seniority");
          expect(group).toContain("Pro");
          expect(group).toContain("These filters are not applied on Free.");
          expect(group).toContain('href="/pricing"');
          expect(
            group.indexOf("These filters are not applied on Free.")
          ).toBeLessThan(group.indexOf('aria-pressed="true"'));
          expect(html).toContain('aria-describedby="pro-refinements-note"');
          expect(html).toContain('id="search"');
          expect(html).toContain("remote in Canada");
          expect(html.match(/class="job"/gu)).toHaveLength(2);
        }
      )
  );

  it.effect.each(["anonymous", "Free"])(
    "keeps %s shared-link selections visibly requested but unapplied",
    (viewer) =>
      Effect.map(
        renderAs(
          "/?salary=listed&pay=200000&level=director",
          viewer === "anonymous"
            ? SessionState.SignedOut()
            : SessionState.SignedIn({ account }),
          viewer === "anonymous"
            ? Option.none<MembershipValue>()
            : Option.some(free)
        ),
        (html) => {
          const group = groupOf(html);

          expect(group).toContain("These selections are not applied on Free.");
          expect(group).toMatch(/aria-pressed="true"[^>]*>director</u);
          expect(group).toMatch(/aria-pressed="true"[^>]*>200k</u);
          expect(group).toMatch(
            /aria-pressed="true"[^>]*>Only roles that state a salary</u
          );
          expect(html.match(/class="job"/gu)).toHaveLength(2);
        }
      )
  );

  it.effect("shows Pro selections without a false unapplied warning", () =>
    Effect.map(
      renderAs(
        "/?salary=listed&pay=200000&level=director",
        SessionState.SignedIn({ account }),
        Option.some(pro)
      ),
      (html) => {
        const group = groupOf(html);

        expect(group).toContain("Salary and seniority");
        expect(group).toMatch(/aria-pressed="true"[^>]*>200k</u);
        expect(group).not.toContain("not applied");
        expect(group).not.toContain("See Pro plans");
      }
    )
  );
});
