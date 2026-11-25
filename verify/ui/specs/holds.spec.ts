import { expect, test } from "@playwright/test";

import {
  boardRows,
  freshEmail,
  goNav,
  hold,
  makePro,
  newPage,
  rpcReply,
  saveRow,
  savedSearchCount,
  shot,
  signIn,
  waitForBoard,
} from "./support.ts";

test("holds: a stale board reply never fills the list after a filter change", async ({
  browser,
}) => {
  const name = "holds-stale-board";
  const page = await newPage(browser);

  await page.goto("/");
  await waitForBoard(page);
  const count = page.locator("p.count[aria-live]");
  const before = (await count.textContent()) ?? "";

  const stale = await hold(page, "listJobs");
  await page.locator("button.phrase:visible", { hasText: /^day$/u }).click();
  await stale.reached;
  const fresh = rpcReply(page, "listJobs");
  await page.locator("button.phrase:visible", { hasText: /^3 days$/u }).click();
  await fresh;
  await expect(count).not.toHaveText(before);
  const wanted = (await count.textContent()) ?? "";
  const rows = await boardRows(page).locator(".role-title").allTextContents();
  await shot(page, `${name}-1-new-filter-listed`);

  stale.release();
  await stale.settled;
  await page.waitForTimeout(1000);
  await shot(page, `${name}-2-stale-reply-released`);

  await expect(count).toHaveText(wanted);
  expect(
    await boardRows(page).locator(".role-title").allTextContents()
  ).toStrictEqual(rows);
});

test("holds: a double-tapped Save search creates one row", async ({
  browser,
}) => {
  const name = "holds-double-save";
  const page = await newPage(browser);
  const email = freshEmail("double-save");
  const sent: string[] = [];

  page.on("request", (request) => {
    if ((request.postData() ?? "").includes('"tag":"saveSearch"')) {
      sent.push(request.url());
    }
  });

  await page.goto("/");
  await signIn(page, email);
  await goNav(page, "Roles");
  await waitForBoard(page);
  await page.locator("button.save-search").dblclick();
  await expect(page.locator(".save-search-note[role=status]")).toContainText(
    "Saved."
  );
  await page.waitForTimeout(1000);
  await shot(page, `${name}-1-saved`);

  expect(sent).toHaveLength(1);
  expect(savedSearchCount(email)).toBe(1);
});

test("holds: stage picks answered in order settle on the stage the server kept", async ({
  browser,
}) => {
  const name = "holds-stage-order";
  const page = await newPage(browser);

  await page.goto("/");
  await signIn(page, freshEmail("stage-order"));
  await goNav(page, "Roles");
  await waitForBoard(page);
  const tracked = rpcReply(page, "trackJob");
  await saveRow(page, 0);
  await tracked;
  await goNav(page, /^Shortlist/u);

  const heading = page
    .locator("section.day", { has: page.locator("li.tracked") })
    .locator(".day-heading");

  const picker = page.locator("li.tracked select");

  const applied = rpcReply(page, "trackJob");

  await picker.selectOption("Applied");
  await applied;

  const interviewing = rpcReply(page, "trackJob");

  await picker.selectOption("Interviewing");
  await interviewing;

  await expect(heading).toHaveText(/^Interviewing/u);
  await shot(page, `${name}-1-settled`);
  await page.reload();
  await expect(heading).toHaveText(/^Interviewing/u);
  await shot(page, `${name}-2-reloaded`);
});

test("holds: creating a token while staying on the page shows its secret", async ({
  browser,
}) => {
  const name = "holds-token-secret";
  const page = await newPage(browser);
  const email = freshEmail("token-secret");

  await page.goto("/");
  await signIn(page, email);
  makePro(email);
  await page.reload();
  await page.locator("#agent-token-label").fill("CI");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.locator(".agent-token-secret")).toBeVisible();
  await shot(page, `${name}-1-secret-shown`);
});
