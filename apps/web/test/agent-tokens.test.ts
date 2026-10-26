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
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import { renderToString } from "foldkit/experimental/server";
import { fromString } from "foldkit/url";

import { AuthClient } from "../src/client/account/auth-client.js";
import { Message as AccountMessage } from "../src/client/account/message.js";
import { SessionState } from "../src/client/account/model.js";
import {
  FetchTokens,
  IssueToken,
  RevokeToken,
} from "../src/client/agent-tokens/command.js";
import { Message } from "../src/client/agent-tokens/message.js";
import { IssueState, TokensState } from "../src/client/agent-tokens/model.js";
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
  active: true,
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
  Message.CompletedIssueToken({
    generation: 0,
    issued: { secret: SECRET, token: server },
  }),
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

const unusedAuth = AuthClient.of({
  currentAccount: Effect.die("unused auth"),
  requestLink: () => Effect.die("unused auth"),
  signOut: Effect.die("unused auth"),
  socialRedirect: () => Effect.die("unused auth"),
});

const signedIn = SessionState.SignedIn({ account: ada });

const refusingWith = (failure: AgentTokenLimit | ProRequired) =>
  JobQueries.of({
    agentTokens: Effect.die("unused"),
    companyIntel: () => Effect.die("unused"),
    companyJobs: () => Effect.die("unused"),
    deleteSearch: () => Effect.die("unused"),
    getJob: () => Effect.die("unused"),
    importShortlist: () => Effect.die("unused"),
    issueAgentToken: () => Effect.fail(failure),
    listJobs: () => Effect.die("unused"),
    membership: Effect.die("unused"),
    noteTrackedJob: () => Effect.die("unused"),
    openBillingPortal: Effect.die("unused"),
    proPlans: Effect.die("unused"),
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

describe("agent tokens", () => {
  it.effect(
    "does not show an earlier account's delayed issued secret after switching accounts",
    () => {
      const before = {
        ...boardInit(flags, urlAt("/account")).model,
        account: {
          ...boardInit(flags, urlAt("/account")).model.account,
          session: signedIn,
        },
        agentTokens: listing([]),
      };

      const typed = boardUpdate(
        before,
        BoardMessage.GotAgentTokensMessage({
          message: Message.UpdatedTokenLabel({ value: "Laptop" }),
        })
      ).model;

      const submitted = boardUpdate(
        typed,
        BoardMessage.GotAgentTokensMessage({
          message: Message.SubmittedIssueToken(),
        })
      );

      const command = submitted.commands?.find(
        (candidate) => candidate.name === "IssueToken"
      );

      if (!command) {
        throw new Error("Expected an issue command");
      }

      const signedOut = boardUpdate(
        submitted.model,
        BoardMessage.GotAccountMessage({
          message: AccountMessage.CompletedFetchSession({
            account: Option.none(),
          }),
        })
      ).model;

      const nextAccount = Schema.decodeSync(Account)({
        email: "grace@example.com",
        id: "user_grace",
        name: "Grace",
      });

      const switched = boardUpdate(
        signedOut,
        BoardMessage.GotAccountMessage({
          message: AccountMessage.CompletedFetchSession({
            account: Option.some(nextAccount),
          }),
        })
      ).model;

      return Effect.gen(function* delayedIssue() {
        const completion = yield* command.effect.pipe(
          Effect.provideService(JobQueries, {
            ...refusingWith(new ProRequired()),
            issueAgentToken: () =>
              Effect.succeed({ secret: SECRET, token: server }),
          }),
          Effect.provideService(AuthClient, unusedAuth)
        );

        const late = boardUpdate(switched, completion).model;

        const text = yield* renderAccount(
          late.account.session,
          pro,
          late.agentTokens
        );

        expect(text).not.toContain(SECRET);
        expect(text).not.toContain("Build server, created");
      });
    }
  );

  it.effect(
    "lets a lapsed member revoke existing tokens without offering issuance",
    () =>
      Effect.map(renderAccount(signedIn, free, listing([laptop])), (text) => {
        expect(text).toContain("Laptop, created October 1, 2026 Revoke");
        expect(text).not.toContain("Create token");
      })
  );

  it("sends the trimmed label once even when Create is pressed twice", () => {
    const typed = update(
      listing([]),
      Message.UpdatedTokenLabel({ value: "  Laptop " })
    ).model;

    const first = update(typed, Message.SubmittedIssueToken());
    const second = update(first.model, Message.SubmittedIssueToken());

    expect(commandNames(first)).toEqual(["IssueToken"]);
    expect(first.commands?.[0]?.args).toEqual({
      generation: 0,
      label: "Laptop",
    });
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
        account: {
          ...boardInit(flags, urlAt("/")).model.account,
          session: signedIn,
        },
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
            generation: back.model.agentTokens.generation,
            tokens: Option.some([server, laptop]),
          }),
        })
      ).model.agentTokens;

      expect(commandNames(back)).toContain("FetchTokens");
      expect(back.model.agentTokens.issue._tag).toBe("Idle");
      expect(back.model.agentTokens.tokens._tag).toBe("Loading");

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
      Message.CompletedRevokeToken({ generation: 0, id: laptop.id, ok: true })
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
      Message.CompletedRevokeToken({ generation: 0, id: laptop.id, ok: false }),
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
            Message.FailedIssueToken({ generation: 0, problem: "AtLimit" }),
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
          steps(listing([]), [
            Message.UpdatedTokenLabel({ value: "Retry" }),
            Message.SubmittedIssueToken(),
            Message.FailedIssueToken({ generation: 0, problem: "Failed" }),
          ])
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
      expect(text).toContain("Laptop, created October 1, 2026 Revoke");
    })
  );

  it.effect("offers Pro when the server says the plan has lapsed", () =>
    Effect.map(
      renderAccount(
        signedIn,
        pro,
        steps(listing([]), [
          Message.UpdatedTokenLabel({ value: "Lapsed" }),
          Message.SubmittedIssueToken(),
          Message.FailedIssueToken({ generation: 0, problem: "ProRequired" }),
        ])
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

const grace = Schema.decodeSync(Account)({
  email: "grace@example.com",
  id: "user_grace",
  name: "Grace",
});

const asAccount = (
  model: ReturnType<typeof boardInit>["model"],
  account: typeof ada | null
) =>
  boardUpdate(
    model,
    BoardMessage.GotAccountMessage({
      message: AccountMessage.CompletedFetchSession({
        account: Option.fromNullishOr(account),
      }),
    })
  ).model;

const boundaries = [
  {
    cross: (model: ReturnType<typeof boardInit>["model"]) =>
      asAccount(model, grace),
    name: "direct account switch",
  },
  {
    cross: (model: ReturnType<typeof boardInit>["model"]) =>
      asAccount(asAccount(model, null), grace),
    name: "sign-out then another account",
  },
  {
    cross: (model: ReturnType<typeof boardInit>["model"]) =>
      asAccount(asAccount(model, null), ada),
    name: "sign-out then the same account",
  },
  {
    cross: (model: ReturnType<typeof boardInit>["model"]) =>
      boardUpdate(
        boardUpdate(model, BoardMessage.ChangedUrl({ url: urlAt("/") })).model,
        BoardMessage.ChangedUrl({ url: urlAt("/account") })
      ).model,
    name: "account page exit and reentry",
  },
  {
    cross: (model: ReturnType<typeof boardInit>["model"]) =>
      asAccount(
        boardUpdate(
          model,
          BoardMessage.GotAccountMessage({
            message: AccountMessage.CompletedSignOut(),
          })
        ).model,
        grace
      ),
    name: "completed sign-out checking then another account",
  },
];

const transportFailure = new RpcClientError({
  reason: new RpcClientDefect({ cause: "offline", message: "offline" }),
});

for (const boundary of boundaries) {
  it.effect(
    `discards token fetch, issue and revoke results across ${boundary.name}`,
    () =>
      Effect.gen(function* staleResults() {
        const started = boardInit(flags, urlAt("/account")).model;

        const before = {
          ...started,
          account: { ...started.account, session: signedIn },
          agentTokens: listing([laptop]),
        };

        const after = boundary.cross(before);

        const current = {
          ...after,
          agentTokens: {
            ...after.agentTokens,
            active: true,
            issue: IssueState.Issuing(),
            revoking: [laptop.id],
            tokens: TokensState.Loaded({ tokens: [laptop] }),
          },
        };

        const successful = JobQueries.of({
          ...refusingWith(new ProRequired()),
          agentTokens: Effect.succeed([server]),
          issueAgentToken: () =>
            Effect.succeed({ secret: SECRET, token: server }),
          revokeAgentToken: () => Effect.void,
        });

        const failing = JobQueries.of({
          ...refusingWith(new ProRequired()),
          agentTokens: Effect.fail(transportFailure),
          revokeAgentToken: () => Effect.fail(transportFailure),
        });

        const commands: readonly {
          readonly effect: Effect.Effect<
            typeof Message.Type,
            never,
            JobQueries
          >;
        }[] = [
          FetchTokens({ generation: before.agentTokens.generation }),
          IssueToken({
            generation: before.agentTokens.generation,
            label: "Old account",
          }),
          RevokeToken({
            generation: before.agentTokens.generation,
            id: laptop.id,
          }),
        ];

        for (const queries of [successful, failing]) {
          for (const command of commands) {
            const message = yield* command.effect.pipe(
              Effect.provideService(JobQueries, queries)
            );

            const awaiting = Schema.is(Message.CompletedFetchTokens)(message)
              ? {
                  ...current,
                  agentTokens: {
                    ...current.agentTokens,
                    tokens: TokensState.Loading(),
                  },
                }
              : current;

            const late = boardUpdate(
              awaiting,
              BoardMessage.GotAgentTokensMessage({ message })
            ).model;

            expect(late.agentTokens).toEqual(awaiting.agentTokens);

            const text = yield* renderAccount(
              late.account.session,
              pro,
              late.agentTokens
            );

            expect(text).not.toContain(SECRET);
            expect(text).not.toContain("Build server, created");

            if (Schema.is(Message.CompletedFetchTokens)(message)) {
              expect(text).toContain("Loading your agent tokens");
            } else {
              expect(text).toContain(
                "Laptop, created October 1, 2026 Revoking"
              );
            }
          }
        }
      })
  );
}

it("forgets the displayed secret at sign-out click and prevents new token commands while leaving", () => {
  const started = boardInit(flags, urlAt("/account")).model;

  const before = {
    ...started,
    account: { ...started.account, session: signedIn },
    agentTokens: issued,
  };

  const leaving = boardUpdate(
    before,
    BoardMessage.GotAccountMessage({ message: AccountMessage.ClickedSignOut() })
  ).model;

  expect(leaving.agentTokens.issue._tag).toBe("Idle");

  const attempted = boardUpdate(
    leaving,
    BoardMessage.GotAgentTokensMessage({
      message: Message.SubmittedIssueToken(),
    })
  );

  expect(commandNames(attempted)).toEqual([]);
  expect(attempted.model.agentTokens).toEqual(leaving.agentTokens);
});

it("allows an explicit retry after a current issue failure", () => {
  const failed = steps(listing([]), [
    Message.UpdatedTokenLabel({ value: " Laptop " }),
    Message.SubmittedIssueToken(),
    Message.FailedIssueToken({ generation: 0, problem: "Failed" }),
  ]);

  const retry = update(failed, Message.SubmittedIssueToken());

  expect(commandNames(retry)).toEqual(["IssueToken"]);
  expect(retry.commands?.[0]?.args).toEqual({ generation: 0, label: "Laptop" });
  expect(retry.model.issue._tag).toBe("Issuing");
});

it("does not let a duplicate issue completion replace the one-time result", () => {
  const duplicate = update(
    issued,
    Message.CompletedIssueToken({
      generation: issued.generation,
      issued: { secret: "another-secret", token: laptop },
    })
  );

  expect(duplicate.model).toEqual(issued);
});

it("keeps token issuance disabled until the initial token list settles", () => {
  const started = boardInit(flags, urlAt("/account")).model;
  const entered = asAccount(started, ada);

  const typed = boardUpdate(
    entered,
    BoardMessage.GotAgentTokensMessage({
      message: Message.UpdatedTokenLabel({ value: "Laptop" }),
    })
  ).model;

  expect(
    commandNames(
      boardUpdate(
        typed,
        BoardMessage.GotAgentTokensMessage({
          message: Message.SubmittedIssueToken(),
        })
      )
    )
  ).toEqual([]);
});

describe("agent token refusals", () => {
  it.effect("names the token limit and a lapsed plan apart", () =>
    Effect.gen(function* refusals() {
      const atLimit = yield* IssueToken({
        generation: 0,
        label: "Sixth",
      }).effect.pipe(
        Effect.provideService(
          JobQueries,
          refusingWith(new AgentTokenLimit({ limit: 5 }))
        )
      );

      const lapsed = yield* IssueToken({
        generation: 0,
        label: "Sixth",
      }).effect.pipe(
        Effect.provideService(JobQueries, refusingWith(new ProRequired()))
      );

      expect(atLimit).toStrictEqual(
        Message.FailedIssueToken({ generation: 0, problem: "AtLimit" })
      );
      expect(lapsed).toStrictEqual(
        Message.FailedIssueToken({ generation: 0, problem: "ProRequired" })
      );
    })
  );
});
