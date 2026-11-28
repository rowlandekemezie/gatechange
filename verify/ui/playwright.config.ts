import { readFileSync } from "node:fs";

import { defineConfig } from "@playwright/test";

const stage = process.env.VERIFY_STAGE ?? "verify-sm-ui";

const baseURL = readFileSync(`/tmp/verify-jobs/${stage}/url`, "utf-8").trim();

export default defineConfig({
  expect: { timeout: 10_000 },
  fullyParallel: false,
  outputDir: "../out/ui/test-results",
  reporter: [["list"]],
  testDir: "./specs",
  timeout: 120_000,
  use: {
    baseURL,
    channel: "chrome",
    headless: true,
    trace: "off",
  },
  workers: 1,
});
