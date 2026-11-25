import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "@playwright/test";
import type { Browser, Page, Route } from "@playwright/test";

const stage = process.env.VERIFY_STAGE ?? "verify-sm-ui";

const runDir = `/tmp/verify-jobs/${stage}`;

const repo = path.resolve(import.meta.dirname, "../../..");

const outbox = path.join(repo, "apps/infra/.alchemy/local/email/text");

const shots = path.resolve(import.meta.dirname, "../screenshots");

mkdirSync(shots, { recursive: true });

const BLOCKED = /posthog\.com|sentry\.io|\/ingest\//u;

const RPC = /\/rpc\/?$/u;

const MAGIC_LINK = /https?:\/\/\S+\/account\/confirm\?token=\S+/u;

let opened = 0;

export const knownBug = () => {
  if (process.env.SHOW_BUGS !== "1") {
    test.fail();
  }
};

export const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

export const freshEmail = (slug: string) =>
  `sm-ui-${slug}-${Date.now().toString(36)}@example.com`;

export const newPage = async (browser: Browser) => {
  opened += 1;

  const context = await browser.newContext({
    extraHTTPHeaders: {
      "cf-connecting-ip": `10.${Math.floor(Date.now() / 65_536) % 250}.${Math.floor(Date.now() / 256) % 250}.${opened}`,
    },
    viewport: { height: 900, width: 1280 },
  });

  await context.route(BLOCKED, async (route) => {
    await route.abort();
  });

  return await context.newPage();
};

const tagsOf = (body: string) =>
  [...body.matchAll(/"tag":"(?<tag>[A-Za-z]+)"/gu)].map(
    (found) => found.groups?.tag ?? ""
  );

type HoldMode = "reply" | "request";

export interface Hold {
  readonly reached: Promise<boolean>;
  readonly release: () => void;
  readonly settled: Promise<boolean>;
}

export const hold = async (
  page: Page,
  tag: string,
  { mode = "reply" }: { mode?: HoldMode } = {}
): Promise<Hold> => {
  const reached = Promise.withResolvers<boolean>();
  const gate = Promise.withResolvers<boolean>();
  const settled = Promise.withResolvers<boolean>();
  let taken = false;

  const handler = async (route: Route) => {
    if (taken || !tagsOf(route.request().postData() ?? "").includes(tag)) {
      await route.fallback();

      return;
    }

    taken = true;

    if (mode === "reply") {
      const response = await route.fetch();

      reached.resolve(true);
      await gate.promise;
      await route.fulfill({ response });
    } else {
      reached.resolve(true);
      await gate.promise;
      await route.continue();
    }

    settled.resolve(true);
  };

  await page.route(RPC, handler);

  return {
    reached: reached.promise,
    release: () => {
      gate.resolve(true);
    },
    settled: settled.promise,
  };
};

export const rpcReply = async (page: Page, tag: string) =>
  await page.waitForResponse(
    (response) =>
      RPC.test(response.url()) &&
      tagsOf(response.request().postData() ?? "").includes(tag)
  );

export const header = (page: Page) =>
  page.getByRole("navigation", { name: "Site" });

export const accountLink = (page: Page) =>
  header(page).locator("a.nav-account");

const mailFiles = () =>
  existsSync(outbox)
    ? readdirSync(outbox).map((file) => path.join(outbox, file))
    : [];

const linkFor = (before: ReadonlySet<string>) => {
  const fresh = mailFiles()
    .filter((file) => !before.has(file))
    .toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .map((file) => readFileSync(file, "utf-8"));

  const [link] = MAGIC_LINK.exec(fresh[0] ?? "") ?? [];

  return link ?? "";
};

export const signIn = async (page: Page, email: string) => {
  const before = new Set(mailFiles());

  await accountLink(page).click();
  await page.locator("form.sign-in input").fill(email);
  await page.locator("form.sign-in input").press("Enter");
  await expect(page.locator(".sign-in-sent")).toContainText(email);

  await expect.poll(() => linkFor(before)).not.toBe("");

  const emailed = new URL(linkFor(before));

  await page.goto(`${emailed.pathname}${emailed.search}`);
  await expect(page.locator(".detail.account")).toContainText(
    `signs you in as ${email}`
  );
  await page.getByRole("button", { name: "Finish signing in" }).click();
  await expect(accountLink(page)).toHaveText(email);
};

export const signOut = async (page: Page) => {
  await page.locator(".account button.more", { hasText: "Sign out" }).click();
  await expect(accountLink(page)).toHaveText("Sign in");
};

export const boardRows = (page: Page) => page.locator(".board .departure");

export const waitForBoard = async (page: Page) => {
  await expect(boardRows(page).nth(9)).toBeVisible();
};

export const rowTitle = async (page: Page, index: number) =>
  (await boardRows(page).nth(index).locator(".role-title").textContent()) ?? "";

export const saveRow = async (page: Page, index: number) => {
  await boardRows(page)
    .nth(index)
    .locator('button.mark[aria-label="Save"]')
    .click();
};

export const goNav = async (page: Page, name: RegExp | string) => {
  await header(page).getByRole("link", { name }).click();
};

const database = () => {
  const file = readFileSync(`${runDir}/d1`, "utf-8").trim();

  if (!file.includes("/.alchemy/local/d1/")) {
    throw new Error(`refusing a D1 file outside the local stage: ${file}`);
  }

  return new DatabaseSync(file);
};

export const makePro = (email: string) => {
  const db = database();

  try {
    const [id] = db
      .prepare('SELECT id FROM "user" WHERE email = ?')
      .all(email)
      .map((row) => String(row.id));

    if (id === undefined) {
      throw new Error(`no local account for ${email}`);
    }

    const now = Date.now();

    db.prepare(
      "INSERT INTO subscriptions (subscription_id, account_id, plan, status, period_end, cancel_at_period_end, event_created, event_rank, event_id) VALUES (?, ?, 'Monthly', 'active', ?, 0, ?, 0, ?)"
    ).run(
      `sub_verify_${id}`,
      id,
      now + 30 * 86_400_000,
      now,
      `evt_verify_${id}`
    );
  } finally {
    db.close();
  }
};

export const savedSearchCount = (email: string) => {
  const db = database();

  try {
    const count = db
      .prepare(
        'SELECT count(*) AS n FROM saved_searches WHERE account_id = (SELECT id FROM "user" WHERE email = ?)'
      )
      .get(email)?.n;

    return Number(count);
  } finally {
    db.close();
  }
};
