import {
  isPro,
  MAX_AGENT_TOKEN_LABEL_LENGTH,
  MAX_AGENT_TOKENS,
  MCP_PATH,
} from "@rat-stack/core/contracts";
import type { AgentTokenValue } from "@rat-stack/core/contracts";
import { Array, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineView } from "foldkit/submodel";

import { Message } from "../../client/agent-tokens/message.js";
import type {
  IssueProblemValue,
  MessageValue,
} from "../../client/agent-tokens/message.js";
import {
  canIssue,
  IssueState,
  TokensState,
} from "../../client/agent-tokens/model.js";
import type { ModelValue } from "../../client/agent-tokens/model.js";
import { MembershipState } from "../../client/billing/model.js";
import type { MembershipStateValue } from "../../client/billing/model.js";
import { pricingRouter } from "../../client/route.js";
import { calendarDate } from "../pricing/view.js";

interface AgentTokensInputs {
  readonly membership: MembershipStateValue;
  readonly origin: string;
}

const TOKEN_PLACEHOLDER = "<your-token>";

const LABEL_ID = "agent-token-label";

export const mcpUrlOf = (origin: string) => `${origin}${MCP_PATH}`;

export const addServerCommandOf = (origin: string) =>
  `claude mcp add --transport http jobs ${mcpUrlOf(origin)}`;

export const connectCommandOf = (origin: string, secret: string) =>
  `${addServerCommandOf(origin)} --header "Authorization: Bearer ${secret}"`;

const problemText: Record<Exclude<IssueProblemValue, "ProRequired">, string> = {
  AtLimit: `You can hold ${MAX_AGENT_TOKENS} tokens. Revoke one to create another.`,
  Failed: "We could not create the token. Try again in a minute.",
};

const section = (
  h: HtmlBuilder<MessageValue>,
  children: readonly Html[]
): Html =>
  h.section(
    [h.Class("agent-tokens"), h.AriaLabelledBy("agent-tokens-title")],
    [h.h2([h.Id("agent-tokens-title")], ["AI agents"]), ...children]
  );

const upsell = (h: HtmlBuilder<MessageValue>): Html =>
  h.p(
    [h.Class("account-lede")],
    [
      "Agent tokens come with Pro. ",
      h.a([h.Href(pricingRouter())], ["See Pro plans"]),
    ]
  );

const tokenItem = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>,
  token: AgentTokenValue
): Html => {
  const isRevoking = Array.contains(model.revoking, token.id);

  return h.keyed("li")(
    token.id,
    [h.Class("agent-token")],
    [
      h.span(
        [h.Class("agent-token-label")],
        [`${token.label}, created ${calendarDate(token.createdAt)}`]
      ),
      h.button(
        [
          h.Type("button"),
          h.Class("mark"),
          h.Disabled(isRevoking),
          h.AriaLabel(`Revoke token: ${token.label}`),
          h.OnClick(Message.ClickedRevokeToken({ id: token.id })),
        ],
        [isRevoking ? "Revoking…" : "Revoke"]
      ),
    ]
  );
};

const tokenList = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): readonly Html[] =>
  TokensState.match<readonly Html[]>(model.tokens, {
    Failed: () => [
      h.p(
        [h.Class("status"), h.Role("alert")],
        ["We could not load your agent tokens. Reload to try again."]
      ),
    ],
    Loaded: ({ tokens }) =>
      Array.isReadonlyArrayEmpty(tokens)
        ? [h.p([h.Class("account-lede")], ["You have no agent tokens yet."])]
        : [
            h.ul(
              [h.Class("agent-token-list")],
              tokens.map((token) => tokenItem(model, h, token))
            ),
          ],
    Loading: () => [
      h.p(
        [h.Class("status"), h.Role("status")],
        ["Loading your agent tokens…"]
      ),
    ],
    NotAsked: () => [],
  });

const issueForm = (model: ModelValue, h: HtmlBuilder<MessageValue>): Html => {
  const isIssuing = Schema.is(IssueState.Issuing)(model.issue);

  return h.form(
    [
      h.Class("sign-in"),
      h.Novalidate(true),
      h.OnSubmit(Message.SubmittedIssueToken()),
    ],
    [
      h.label([h.For(LABEL_ID)], ["Token label"]),
      h.div(
        [h.Class("sign-in-row")],
        [
          h.input([
            h.Id(LABEL_ID),
            h.Type("text"),
            h.Name("label"),
            h.Value(model.label),
            h.Maxlength(MAX_AGENT_TOKEN_LABEL_LENGTH),
            h.Placeholder("Claude on my laptop"),
            h.OnInput((value) => Message.UpdatedTokenLabel({ value })),
          ]),
          h.button(
            [
              h.Type("submit"),
              h.Class("search-button"),
              h.Disabled(!canIssue(model)),
            ],
            [isIssuing ? "Creating…" : "Create token"]
          ),
        ]
      ),
    ]
  );
};

const secretOf = (model: ModelValue) =>
  Schema.is(IssueState.Issued)(model.issue)
    ? model.issue.secret
    : TOKEN_PLACEHOLDER;

const issueNote = (
  model: ModelValue,
  h: HtmlBuilder<MessageValue>
): readonly Html[] =>
  IssueState.match<readonly Html[]>(model.issue, {
    Idle: () => [],
    Issued: ({ secret }) => [
      h.div(
        [h.Class("agent-token-secret"), h.Role("status")],
        [
          h.p(
            [],
            [
              "Your new token is below. Copy it now. It will not be shown again.",
            ]
          ),
          h.pre([], [h.code([], [secret])]),
        ]
      ),
    ],
    Issuing: () => [],
    Refused: ({ problem }) =>
      problem === "ProRequired"
        ? []
        : [
            h.p(
              [h.Class("billing-problem"), h.Role("alert")],
              [problemText[problem]]
            ),
          ],
  });

const proPanel = (
  model: ModelValue,
  origin: string,
  h: HtmlBuilder<MessageValue>
): readonly Html[] => [
  h.p(
    [h.Class("account-lede")],
    [
      "Connect an AI agent to the board with a personal token. The agent can search roles and use your saved searches and tracker. MCP endpoint: ",
      h.code([], [mcpUrlOf(origin)]),
    ]
  ),
  ...tokenList(model, h),
  issueForm(model, h),
  ...issueNote(model, h),
  h.p([h.Class("tier-note")], ["Connect Claude Code with:"]),
  h.pre(
    [h.Class("agent-connect")],
    [h.code([], [connectCommandOf(origin, secretOf(model))])]
  ),
];

const isRefusedForPro = (model: ModelValue) =>
  Schema.is(IssueState.Refused)(model.issue) &&
  model.issue.problem === "ProRequired";

export const agentTokensPanel = defineView<
  ModelValue,
  MessageValue,
  AgentTokensInputs
>((model, { membership, origin }, h) =>
  Schema.is(MembershipState.Loaded)(membership)
    ? section(
        h,
        isPro(membership.membership.entitlement) && !isRefusedForPro(model)
          ? proPanel(model, origin, h)
          : [...tokenList(model, h), upsell(h)]
      )
    : h.empty
);
