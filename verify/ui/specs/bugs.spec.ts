import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  accountLink,
  boardRows,
  freshEmail,
  goNav,
  header,
  hold,
  knownBug,
  makePro,
  newPage,
  rowTitle,
  rpcReply,
  saveRow,
  savedSearchCount,
  shot,
  signIn,
  signOut,
  waitForBoard,
} from "./support.ts";

const STORED_SHORTLIST = "jobs.shortlist.v1";

const storedShortlist = async (page: Page) =>
  (await page.evaluate((key) => localStorage.getItem(key), STORED_SHORTLIST)) ??
  "";

const proBadge = (page: Page) =>
  header(page).locator('.pro-badge[aria-label="Your plan: Pro"]');

const cardHeading = (page: Page) =>
  page
    .locator("section.day", { has: page.locator("li.tracked") })
    .locator(".day-heading");

const signedInPro = async (page: Page, slug: string) => {
  const email = freshEmail(slug);

  await page.goto("/");
  await signIn(page, email);
  makePro(email);
  await page.reload();
  await expect(proBadge(page)).toBeVisible();

  return email;
};

test("tracker-session: a tracker reply after sign-out keeps the browser shortlist", async ({
  browser,
}) => {
  knownBug();
  const name = "tracker-session";
  const page = await newPage(browser);

  await page.goto("/");
  await waitForBoard(page);
  const first = await rowTitle(page, 0);
  const second = await rowTitle(page, 1);
  await saveRow(page, 0);
  await expect.poll(async () => await storedShortlist(page)).toContain(first);

  const sync = await hold(page, "trackedJobs");
  await signIn(page, freshEmail(name));
  await sync.reached;
  await shot(page, `${name}-1-signed-in-sync-held`);

  await signOut(page);
  sync.release();
  await sync.settled;
  await shot(page, `${name}-2-signed-out-reply-released`);

  await goNav(page, "Roles");
  await waitForBoard(page);
  await saveRow(page, 1);
  await page.waitForTimeout(500);
  await page.reload();
  await goNav(page, /^Shortlist/u);
  await shot(page, `${name}-3-reloaded-shortlist`);

  const titles = await page.locator(".jobs .job-title").allTextContents();
  expect(titles).toContain(second);
  expect(titles, "the job saved before sign-in is still saved").toContain(
    first
  );
});

test("tracker-changes: two quick stage picks end with the card matching the server", async ({
  browser,
}) => {
  knownBug();
  const name = "tracker-changes";
  const page = await newPage(browser);

  await page.goto("/");
  await signIn(page, freshEmail(name));
  await goNav(page, "Roles");
  await waitForBoard(page);
  const tracked = rpcReply(page, "trackJob");
  await saveRow(page, 0);
  await tracked;
  await goNav(page, /^Shortlist/u);
  await expect(cardHeading(page)).toHaveText(/^Saved/u);

  const slow = await hold(page, "trackJob", { mode: "request" });
  const picker = page.locator("li.tracked select");
  await picker.selectOption("Applied");
  await slow.reached;
  const fast = rpcReply(page, "trackJob");
  await picker.selectOption("Interviewing");
  await fast;
  await page.waitForTimeout(2000);
  slow.release();
  await slow.settled;
  await page.waitForTimeout(500);
  await shot(page, `${name}-1-settled`);
  const shown = (await cardHeading(page).textContent()) ?? "";

  await page.reload();
  await expect(page.locator("li.tracked")).toBeVisible();
  await shot(page, `${name}-2-reloaded`);
  const saved = (await cardHeading(page).textContent()) ?? "";

  expect(shown, "the card before reload shows the stage the server kept").toBe(
    saved
  );
});

test("MovingOnlyWhileMoving: saving a job during the move leaves the Move buttons usable", async ({
  browser,
}) => {
  knownBug();
  const name = "moving-only-while-moving";
  const page = await newPage(browser);

  await page.goto("/");
  await waitForBoard(page);
  await saveRow(page, 0);
  const email = freshEmail("moving");
  await signIn(page, email);
  await goNav(page, /^Shortlist/u);
  const offer = page.locator(".import-offer");
  await expect(offer).toContainText(email);

  const move = await hold(page, "importShortlist");
  await offer.getByRole("button", { name: /^Move them/u }).click();
  await move.reached;
  await shot(page, `${name}-1-moving`);

  await goNav(page, "Roles");
  await waitForBoard(page);
  const tracked = rpcReply(page, "trackJob");
  await saveRow(page, 1);
  await tracked;
  await goNav(page, /^Shortlist/u);
  move.release();
  await move.settled;
  await page.waitForTimeout(1000);
  await shot(page, `${name}-2-settled`);

  await expect(
    page.getByRole("button", { name: "Moving…" }),
    "no Move button stays stuck on Moving… once both replies are in"
  ).toHaveCount(0, { timeout: 3000 });
});

test("billing: a membership reply after sign-out shows no Pro badge", async ({
  browser,
}) => {
  knownBug();
  const name = "billing";
  const page = await newPage(browser);

  await signedInPro(page, name);
  await shot(page, `${name}-1-pro`);

  const membership = await hold(page, "membership");
  await page.reload();
  await expect(accountLink(page)).not.toHaveText("Sign in");
  await membership.reached;
  await signOut(page);
  membership.release();
  await membership.settled;
  await page.waitForTimeout(500);
  await shot(page, `${name}-2-signed-out-reply-released`);

  await expect(accountLink(page)).toHaveText("Sign in");
  await expect(
    proBadge(page),
    "a signed-out header carries no Pro badge"
  ).toHaveCount(0, { timeout: 3000 });
});

test("agent tokens: leaving while a token is created still shows its secret on return", async ({
  browser,
}) => {
  knownBug();
  const name = "agent-tokens";
  const page = await newPage(browser);

  await signedInPro(page, name);
  await page.locator("#agent-token-label").fill("CI");

  const issue = await hold(page, "issueAgentToken");
  await page.getByRole("button", { name: "Create token" }).click();
  await issue.reached;
  await shot(page, `${name}-1-creating`);

  await goNav(page, "Roles");
  await waitForBoard(page);
  issue.release();
  await issue.settled;
  await accountLink(page).click();
  await expect(page.locator(".agent-token")).toHaveCount(1);
  await page.waitForTimeout(500);
  await shot(page, `${name}-2-back-on-account`);

  await expect(
    page.locator(".agent-token-secret"),
    "the new token's secret is on screen"
  ).toBeVisible({ timeout: 3000 });
});

test("saved searches: a list read before a delete does not bring the search back", async ({
  browser,
}) => {
  knownBug();
  const name = "saved-searches";
  const email = freshEmail(name);
  const page = await newPage(browser);

  await page.goto("/");
  await signIn(page, email);
  await goNav(page, "Roles");
  await waitForBoard(page);
  await page.locator("button.save-search").click();
  await expect(page.locator(".save-search-note[role=status]")).toContainText(
    "Saved."
  );
  await accountLink(page).click();
  await expect(page.locator(".saved-search")).toHaveCount(1);

  await goNav(page, "Roles");
  const refetch = await hold(page, "savedSearches");
  await accountLink(page).click();
  await refetch.reached;
  const deleted = rpcReply(page, "deleteSearch");
  await page
    .getByRole("button", { name: /^Delete saved search/u })
    .first()
    .click();
  await deleted;
  await shot(page, `${name}-1-deleted`);
  refetch.release();
  await refetch.settled;
  await page.waitForTimeout(500);
  await shot(page, `${name}-2-old-list-released`);
  expect(savedSearchCount(email), "the server deleted the search").toBe(0);

  await expect(
    page.locator(".saved-search"),
    "the deleted search stays gone"
  ).toHaveCount(0, { timeout: 3000 });
});

test("saved note: changing filters while saving does not say Saved under the new filters", async ({
  browser,
}) => {
  knownBug();
  const name = "saved-note";
  const page = await newPage(browser);

  await page.goto("/");
  await signIn(page, freshEmail(name));
  await goNav(page, "Roles");
  await waitForBoard(page);

  const save = await hold(page, "saveSearch");
  await page.locator("button.save-search").click();
  await save.reached;
  await page
    .locator("button.phrase:visible", { hasText: /^director$/u })
    .click();
  await shot(page, `${name}-1-role-toggled-while-saving`);
  save.release();
  await save.settled;
  await expect(boardRows(page).first()).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, `${name}-2-reply-released`);

  await expect(
    page.locator(".save-search-note[role=status]", { hasText: "Saved." }),
    "no Saved note for filters that were never saved"
  ).toHaveCount(0, { timeout: 3000 });
});
