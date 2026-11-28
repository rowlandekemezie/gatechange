import { ACCOUNT_PATH, SITE_NAME } from "@rat-stack/core/contracts";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { addServerCommandOf, mcpUrlOf } from "../agent-tokens/view.js";

interface Copying<M> {
  readonly copied: Option.Option<string>;
  readonly onCopy: (text: string) => M;
}

const SERVER_NAME = "gate-change";

export const CONNECT_AI_ID = "connect-ai";

export const connectAiHref = `${ACCOUNT_PATH}#${CONNECT_AI_ID}`;

export const claudeConnectorLinkOf = (origin: string) =>
  `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent(SITE_NAME)}&connectorUrl=${encodeURIComponent(mcpUrlOf(origin))}`;

export const cursorInstallLinkOf = (origin: string) =>
  `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(btoa(JSON.stringify({ url: mcpUrlOf(origin) })))}`;

const vscodeServerOf = (origin: string) =>
  JSON.stringify({ name: SERVER_NAME, type: "http", url: mcpUrlOf(origin) });

export const vscodeInstallLinkOf = (origin: string) =>
  `vscode:mcp/install?${encodeURIComponent(vscodeServerOf(origin))}`;

const cursorConfigOf = (origin: string) =>
  JSON.stringify(
    { mcpServers: { [SERVER_NAME]: { url: mcpUrlOf(origin) } } },
    null,
    2
  );

interface AppSetup {
  readonly name: string;
  readonly install: Option.Option<{
    readonly href: string;
    readonly label: string;
    readonly opensTab: boolean;
  }>;
  readonly steps: string;
  readonly snippet: Option.Option<string>;
}

const appsOf = (origin: string): readonly AppSetup[] => [
  {
    install: Option.some({
      href: claudeConnectorLinkOf(origin),
      label: "Add to Claude",
      opensTab: true,
    }),
    name: "Claude",
    snippet: Option.none(),
    steps:
      "For claude.ai and the desktop app. Or open Customize > Connectors, choose Add custom connector and paste the URL. Free Claude plans allow one custom connector.",
  },
  {
    install: Option.none(),
    name: "ChatGPT",
    snippet: Option.none(),
    steps:
      "No one-click setup yet, and it needs a paid plan: Business, Enterprise or Edu, or Pro with read-only tools. Open Plugins, press +, choose Add custom MCP server, paste the URL and pick OAuth. Older workspaces use Settings > Apps > Create. Menus change often.",
  },
  {
    install: Option.some({
      href: cursorInstallLinkOf(origin),
      label: "Add to Cursor",
      opensTab: false,
    }),
    name: "Cursor",
    snippet: Option.some(cursorConfigOf(origin)),
    steps: "Or add this to your mcp.json:",
  },
  {
    install: Option.some({
      href: vscodeInstallLinkOf(origin),
      label: "Add to VS Code",
      opensTab: false,
    }),
    name: "VS Code",
    snippet: Option.some(`code --add-mcp '${vscodeServerOf(origin)}'`),
    steps: "Or run:",
  },
  {
    install: Option.none(),
    name: "Claude Code",
    snippet: Option.some(addServerCommandOf(origin)),
    steps: "Run this, then sign in from /mcp in Claude Code:",
  },
];

const copyable = <M>(
  text: string,
  what: string,
  { copied, onCopy }: Copying<M>,
  h: HtmlBuilder<M>
): Html =>
  h.div(
    [h.Class("connect-ai-copy")],
    [
      h.pre([h.Tabindex(0)], [h.code([], [text])]),
      h.button(
        [
          h.Type("button"),
          h.Class("mark"),
          h.AriaLabel(`Copy ${what}`),
          h.OnClick(onCopy(text)),
        ],
        [Option.contains(copied, text) ? "Copied" : "Copy"]
      ),
    ]
  );

const appItem = <M>(
  app: AppSetup,
  copying: Copying<M>,
  h: HtmlBuilder<M>
): Html =>
  h.li(
    [h.Class("connect-ai-app")],
    [
      h.h3([], [app.name]),
      ...Option.match(app.install, {
        onNone: () => [],
        onSome: ({ href, label, opensTab }) => [
          h.a(
            [
              h.Class("search-button connect-ai-install"),
              h.Href(href),
              ...(opensTab
                ? [h.Target("_blank"), h.Rel("noopener noreferrer")]
                : []),
            ],
            [label]
          ),
        ],
      }),
      h.p([h.Class("tier-note")], [app.steps]),
      ...Option.match(app.snippet, {
        onNone: () => [],
        onSome: (snippet) => [
          copyable(snippet, `${app.name} setup`, copying, h),
        ],
      }),
    ]
  );

export const connectAiPanel = <M>(
  origin: string,
  copying: Copying<M>,
  h: HtmlBuilder<M>
): Html =>
  h.section(
    [
      h.Id(CONNECT_AI_ID),
      h.Class("connect-ai"),
      h.AriaLabelledBy("connect-ai-title"),
    ],
    [
      h.h2([h.Id("connect-ai-title")], ["Connect your AI"]),
      h.p(
        [h.Class("account-lede")],
        [
          `Search ${SITE_NAME} from your AI app. Add this URL, then sign in to ${SITE_NAME} when the app asks. Any account can search roles. Pro adds saved searches and the tracker.`,
        ]
      ),
      copyable(mcpUrlOf(origin), "the MCP URL", copying, h),
      h.ul(
        [h.Class("connect-ai-apps")],
        appsOf(origin).map((app) => appItem(app, copying, h))
      ),
    ]
  );
