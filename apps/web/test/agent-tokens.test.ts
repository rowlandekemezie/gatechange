import { describe, expect, it } from "@effect/vitest";
import {
  Account,
  AgentToken,
  AgentTokenLimit,
  FREE,
  ProEntitlement,
  ProRequired,
} from "@rat-stack/core/contracts";
import type { MembershipValue } from "@rat-stack/core/contracts";
import { Effect, Option, Schema } from "effect";
import { renderToString } from "foldkit/experimental/server";
import { fromString } from "foldkit/url";

import { SessionState } from "../src/client/account/model.js";
import { IssueToken } from "../src/client/agent-tokens/command.js";
import { Message } from "../src/client/agent-tokens/message.js";
import { TokensState } from "../src/client/agent-tokens/model.js";
import type { ModelValue } from "../src/client/agent-tokens/model.js";
import { init, update } from "../src/client/agent-tokens/update.js";
import { application } from "../src/client/application.js";
import { MembershipState } from "../src/client/billing/model.js";
import { Message as BoardMessage } from "../src/client/board/message.js";
import { Preload } from "../src/client/board/model.js";
import { JobQueries } from "../src/client/board/queries.js";
import {
  init as boardInit,
  update as boardUpdate,
} from "../src/client/board/update.js";

const ORIGIN = "https://jobs.example";

const SECRET = "jobs_pat_s3cret";

const flags = { origin: ORIGIN, preload: Preload.Nothing() };

const urlAt = (path: string) =>
  Option.getOrThrow(fromString(`${ORIGIN}${path}`));

const ada = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

const tokenOf = Schema.decodeSync(AgentToken);

const laptop = tokenOf({
  createdAt: Date.UTC(2026, 9, 1),
  id: "token-laptop",
  label: "Laptop",
});

const server = tokenOf({
  createdAt: Date.UTC(2026, 9, 18),
  id: "token-server",
  label: "Build server",
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

const commandNames = (step: {
  readonly commands?: readonly { readonly name: string }[];
}) => (step.commands ?? []).map((command) => command.name);

const listing = (tokens: readonly (typeof AgentToken.Type)[]): ModelValue => ({
  ...init().model,
  tokens: TokensState.Loaded({ tokens }),
});

const steps = (
  model: ModelValue,
  messages: readonly (typeof Message.Type)[]
): ModelValue => {
  let current = model;

  for (const message of messages) {
    current = update(current, message).model;
  }

  return current;
};

const issued = steps(listing([laptop]), [
  Message.UpdatedTokenLabel({ value: " Build server " }),
  Message.SubmittedIssueToken(),
  Message.CompletedIssueToken({ issued: { secret: SECRET, token: server } }),
]);

const renderAccount = (
  session: typeof SessionState.Type,
  membership: MembershipValue,
  agentTokens: ModelValue
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
            agentTokens,
            billing: {
              ...started.model.billing,
              membership: MembershipState.Loaded({ membership }),
            },
          },
        };
      },
    },
    { flags, url: `${ORIGIN}/account` }
  ).pipe(
    Effect.map(({ html }) =>
      html
        .replaceAll(/<[^>]+>/gu, " ")
        .replaceAll("&quot;", '"')
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll(/\s+/gu, " ")
    )
  );

const signedIn = SessionState.SignedIn({ account: ada });

describe("agent tokens", () => {
  it("sends the trimmed label once even when Create is pressed twice", () => {
    const typed = update(
      listing([]),
      Message.UpdatedTokenLabel({ value: "  Laptop " })
    ).model;

    const first = update(typed, Message.SubmittedIssueToken());
    const second = update(first.model, Message.SubmittedIssueToken());

    expect(commandNames(first)).toEqual(["IssueToken"]);
    expect(first.commands?.[0]?.args).toEqual({ label: "Laptop" });
    expect(commandNames(second)).toEqual([]);
  });

  it.effect(
    "shows a new token's secret once, in the connect command, and lists the token",
    () =>
      Effect.map(renderAccount(signedIn, pro, issued), (text) => {
        expect(text).toContain(`It will not be shown again. ${SECRET} `);
        expect(text).toContain(
          `claude mcp add --transport http jobs ${ORIGIN}/mcp --header "Authorization: Bearer ${SECRET}"`
        );
        expect(text).toContain("Build server, created October 18, 2026");
        expect(text).toContain("Laptop, created October 1, 2026");
        expect(issued.label).toBe("");
      })
  );

  it.effect(
    "drops the secret when the account page loads the list again",
    () => {
      const board = {
        ...boardInit(flags, urlAt("/")).model,
        agentTokens: issued,
      };

      const back = boardUpdate(
        board,
        BoardMessage.ChangedUrl({ url: urlAt("/account") })
      );

      const reloaded = boardUpdate(
        back.model,
        BoardMessage.GotAgentTokensMessage({
          message: Message.CompletedFetchTokens({
            tokens: Option.some([server, laptop]),
          }),
        })
      ).model.agentTokens;

      expect(commandNames(back)).toContain("FetchTokens");

      return Effect.map(renderAccount(signedIn, pro, reloaded), (text) => {
        expect(text).not.toContain(SECRET);
        expect(text).toContain("Bearer <your-token>");
        expect(text).toContain("Build server, created October 18, 2026");
      });
    }
  );

  it.effect("removes a revoked token from the list", () => {
    const pressed = update(
      listing([server, laptop]),
      Message.ClickedRevokeToken({ id: laptop.id })
    );

    const revoked = update(
      pressed.model,
      Message.CompletedRevokeToken({ id: laptop.id, ok: true })
    ).model;

    expect(commandNames(pressed)).toEqual(["RevokeToken"]);

    return Effect.map(renderAccount(signedIn, pro, revoked), (text) => {
      expect(text).not.toContain("Laptop");
      expect(text).toContain("Build server");
    });
  });

  it.effect("keeps a token whose revoke failed", () => {
    const failed = steps(listing([laptop]), [
      Message.ClickedRevokeToken({ id: laptop.id }),
      Message.CompletedRevokeToken({ id: laptop.id, ok: false }),
    ]);

    return Effect.map(renderAccount(signedIn, pro, failed), (text) => {
      expect(text).toContain("Laptop, created October 1, 2026 Revoke");
    });
  });

  it.effect(
    "explains the token limit when the server refuses a sixth token",
    () =>
      Effect.map(
        renderAccount(
          signedIn,
          pro,
          steps(listing([laptop]), [
            Message.UpdatedTokenLabel({ value: "Sixth" }),
            Message.SubmittedIssueToken(),
            Message.FailedIssueToken({ problem: "AtLimit" }),
          ])
        ),
        (text) => {
          expect(text).toContain(
            "You can hold 5 tokens. Revoke one to create another."
          );
          expect(text).toContain("Create token");
        }
      )
  );

  it.effect(
    "offers a generic retry when creating fails for another reason",
    () =>
      Effect.map(
        renderAccount(
          signedIn,
          pro,
          update(listing([]), Message.FailedIssueToken({ problem: "Failed" }))
            .model
        ),
        (text) => {
          expect(text).toContain(
            "We could not create the token. Try again in a minute."
          );
        }
      )
  );

  it.effect("offers Pro instead of the form to a Free member", () =>
    Effect.map(renderAccount(signedIn, free, listing([laptop])), (text) => {
      expect(text).toContain("Agent tokens come with Pro. See Pro plans");
      expect(text).not.toContain("Create token");
      expect(text).not.toContain("Laptop");
    })
  );

  it.effect("offers Pro when the server says the plan has lapsed", () =>
    Effect.map(
      renderAccount(
        signedIn,
        pro,
        update(
          listing([]),
          Message.FailedIssueToken({ problem: "ProRequired" })
        ).model
      ),
      (text) => {
        expect(text).toContain("Agent tokens come with Pro. See Pro plans");
        expect(text).not.toContain("Create token");
      }
    )
  );

  it.effect("shows nothing about agents to a signed-out visitor", () =>
    Effect.map(
      renderAccount(SessionState.SignedOut(), pro, listing([laptop])),
      (text) => {
        expect(text).not.toContain("AI agents");
        expect(text).not.toContain("Agent tokens");
      }
    )
  );
});

const refusingWith = (failure: AgentTokenLimit | ProRequired) =>
  JobQueries.of({
    agentTokens: Effect.die("unused"),
    deleteSearch: () => Effect.die("unused"),
    getJob: () => Effect.die("unused"),
    importShortlist: () => Effect.die("unused"),
    issueAgentToken: () => Effect.fail(failure),
    listJobs: () => Effect.die("unused"),
    membership: Effect.die("unused"),
    noteTrackedJob: () => Effect.die("unused"),
    openBillingPortal: Effect.die("unused"),
    revokeAgentToken: () => Effect.die("unused"),
    saveSearch: () => Effect.die("unused"),
    savedSearches: Effect.die("unused"),
    setInstantAlerts: () => Effect.die("unused"),
    signInOptions: Effect.die("unused"),
    startCheckout: () => Effect.die("unused"),
    stats: Effect.die("unused"),
    trackJob: () => Effect.die("unused"),
    trackedJobs: Effect.die("unused"),
    untrackJob: () => Effect.die("unused"),
  });

describe("agent token refusals", () => {
  it.effect("names the token limit and a lapsed plan apart", () =>
    Effect.gen(function* refusals() {
      const atLimit = yield* IssueToken({ label: "Sixth" }).effect.pipe(
        Effect.provideService(
          JobQueries,
          refusingWith(new AgentTokenLimit({ limit: 5 }))
        )
      );

      const lapsed = yield* IssueToken({ label: "Sixth" }).effect.pipe(
        Effect.provideService(JobQueries, refusingWith(new ProRequired()))
      );

      expect(atLimit).toStrictEqual(
        Message.FailedIssueToken({ problem: "AtLimit" })
      );
      expect(lapsed).toStrictEqual(
        Message.FailedIssueToken({ problem: "ProRequired" })
      );
    })
  );
});
