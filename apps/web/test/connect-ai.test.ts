import { describe, expect, it } from "@effect/vitest";
import { Account, FREE } from "@rat-stack/core/contracts";
import type { MembershipValue } from "@rat-stack/core/contracts";
import { Effect, Option, Schema } from "effect";
import { renderToString } from "foldkit/experimental/server";
import { fromString } from "foldkit/url";

import { SessionState } from "../src/client/account/model.js";
import { application } from "../src/client/application.js";
import { MembershipState } from "../src/client/billing/model.js";
import { Message } from "../src/client/board/message.js";
import { Preload } from "../src/client/board/model.js";
import { init, update } from "../src/client/board/update.js";
import {
  claudeConnectorLinkOf,
  cursorInstallLinkOf,
  vscodeInstallLinkOf,
} from "../src/features/connect-ai/view.js";

const ORIGIN = "https://jobs.example";

const MCP_URL = `${ORIGIN}/mcp`;

const flags = { origin: ORIGIN, preload: Preload.Nothing() };

const ada = Schema.decodeSync(Account)({
  email: "ada@example.com",
  id: "user_ada",
  name: "Ada",
});

const free: MembershipValue = { entitlement: FREE, instantAlerts: false };

const htmlAt = (
  path: string,
  session: typeof SessionState.Type,
  copied: Option.Option<string> = Option.none()
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
              membership: MembershipState.Loaded({ membership: free }),
            },
            copied,
          },
        };
      },
    },
    { flags, url: `${ORIGIN}${path}` }
  ).pipe(Effect.map(({ html }) => html.replaceAll("&amp;", "&")));

const textOf = (html: string) =>
  html
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll(/\s+/gu, " ");

const queryOf = (link: string) => link.slice(link.indexOf("?") + 1);

describe("connect your AI links", () => {
  it("prefills the Claude custom connector dialog with the MCP URL", () => {
    expect(claudeConnectorLinkOf(ORIGIN)).toBe(
      "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Gate%20Change&connectorUrl=https%3A%2F%2Fjobs.example%2Fmcp"
    );
  });

  it("installs in Cursor with a base64 remote config named gate-change", () => {
    const link = cursorInstallLinkOf(ORIGIN);
    const params = new URLSearchParams(queryOf(link));

    expect(link).toBe(
      "cursor://anysphere.cursor-deeplink/mcp/install?name=gate-change&config=eyJ1cmwiOiJodHRwczovL2pvYnMuZXhhbXBsZS9tY3AifQ%3D%3D"
    );
    expect(params.get("name")).toBe("gate-change");
    expect(JSON.parse(atob(params.get("config") ?? ""))).toStrictEqual({
      url: MCP_URL,
    });
  });

  it("installs in VS Code with a URL-encoded http server config", () => {
    const link = vscodeInstallLinkOf(ORIGIN);

    expect(link).toBe(
      "vscode:mcp/install?%7B%22name%22%3A%22gate-change%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fjobs.example%2Fmcp%22%7D"
    );
    expect(JSON.parse(decodeURIComponent(queryOf(link)))).toStrictEqual({
      name: "gate-change",
      type: "http",
      url: MCP_URL,
    });
  });

  it("derives every link from the origin it is given", () => {
    const local = "http://localhost:5173";
    const localUrl = `${local}/mcp`;

    expect(
      new URL(claudeConnectorLinkOf(local)).searchParams.get("connectorUrl")
    ).toBe(localUrl);
    expect(
      JSON.parse(
        atob(
          new URLSearchParams(queryOf(cursorInstallLinkOf(local))).get(
            "config"
          ) ?? ""
        )
      )
    ).toStrictEqual({ url: localUrl });
    expect(
      JSON.parse(decodeURIComponent(queryOf(vscodeInstallLinkOf(local))))
    ).toMatchObject({ url: localUrl });
  });
});

describe("connect your AI panel", () => {
  it.effect("shows a free member every app above the agent tokens", () =>
    Effect.map(
      htmlAt("/account", SessionState.SignedIn({ account: ada })),
      (html) => {
        const text = textOf(html);

        expect(html).toContain('id="connect-ai"');
        expect(html).toContain(`href="${claudeConnectorLinkOf(ORIGIN)}"`);
        expect(html).toContain(`href="${cursorInstallLinkOf(ORIGIN)}"`);
        expect(html).toContain(`href="${vscodeInstallLinkOf(ORIGIN)}"`);
        expect(text).toContain("Connect your AI");
        expect(text).toContain(MCP_URL);
        expect(text).toContain("Customize > Connectors");
        expect(text).toContain("ChatGPT");
        expect(text).toContain(
          `claude mcp add --transport http gate-change ${MCP_URL}`
        );
        expect(text.indexOf("Connect your AI")).toBeLessThan(
          text.indexOf("AI agents")
        );
        expect(text).toContain("Agent tokens come with Pro");
      }
    )
  );

  it.effect("shows a signed-out visitor the same setup next to sign-in", () =>
    Effect.map(htmlAt("/account", SessionState.SignedOut()), (html) => {
      expect(html).toContain('id="connect-ai"');
      expect(textOf(html)).not.toContain("AI agents");
    })
  );

  it.effect("links the board's agent promo to the panel", () =>
    Effect.map(htmlAt("/", SessionState.SignedOut()), (html) => {
      expect(html).toContain('href="/account#connect-ai"');
    })
  );

  it.effect("marks the copied text on its own button", () =>
    Effect.map(
      htmlAt("/account", SessionState.SignedOut(), Option.some(MCP_URL)),
      (html) => {
        expect(textOf(html).match(/Copied/gu)).toHaveLength(1);
      }
    )
  );
});

describe("copying setup text", () => {
  const started = init(
    flags,
    Option.getOrThrow(fromString(`${ORIGIN}/account`))
  ).model;

  it("asks the browser to copy the clicked text", () => {
    const step = update(started, Message.ClickedCopy({ text: MCP_URL }));

    expect((step.commands ?? []).map((command) => command.name)).toStrictEqual([
      "CopyText",
    ]);
  });

  it("remembers only the last text it copied", () => {
    const copied = update(
      started,
      Message.CompletedCopy({ text: MCP_URL })
    ).model;

    expect(copied.copied).toStrictEqual(Option.some(MCP_URL));
    expect(update(copied, Message.FailedCopy()).model.copied).toStrictEqual(
      Option.none()
    );
  });
});
