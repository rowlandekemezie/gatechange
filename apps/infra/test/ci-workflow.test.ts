// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test reads the checked-in workflow and stack text once before any Effect runs.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const textAt = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf-8");

const ci = textAt("../../../.github/workflows/ci.yml");

const cleanup = textAt("../../../.github/workflows/pr-preview-cleanup.yml");

const stack = textAt("../stacks/github.ts");

const JOB_HEADING = /^ {2}(?<job>[a-z][a-z-]*):$/gmu;

const jobsOf = (workflow: string) => {
  const body = workflow.slice(workflow.indexOf("\njobs:\n"));
  const headings = [...body.matchAll(JOB_HEADING)];

  return new Map(
    headings.map((heading, index) => [
      heading.groups?.job ?? "",
      body.slice(heading.index, headings[index + 1]?.index),
    ])
  );
};

const ciJobs = jobsOf(ci);

const cloudflareTokensOf = (job = "") => [
  ...new Set(
    [...job.matchAll(/secrets\.(?<token>[A-Z_]*CLOUDFLARE_API_TOKEN)/gu)].map(
      (reference) => reference.groups?.token
    )
  ),
];

describe("CI Cloudflare tokens", () => {
  it.each([
    ["deploy", "CLOUDFLARE_API_TOKEN", "production"],
    ["preview", "PREVIEW_CLOUDFLARE_API_TOKEN", "preview"],
    ["pr-preview", "PR_PREVIEW_CLOUDFLARE_API_TOKEN", "pr-preview"],
  ])(
    "gives the %s job only %s, from the %s environment",
    (job, token, environment) => {
      expect(cloudflareTokensOf(ciJobs.get(job))).toStrictEqual([token]);
      expect(ciJobs.get(job)).toContain(`name: ${environment}\n`);
      expect(ciJobs.get(job)).toContain(`::error::Set ${token}`);
    }
  );

  it("gives the cleanup job the pull request token, from its environment", () => {
    const [job] = jobsOf(cleanup).values();

    expect(cloudflareTokensOf(job)).toStrictEqual([
      "PR_PREVIEW_CLOUDFLARE_API_TOKEN",
    ]);
    expect(job).toContain("environment: pr-preview\n");
    expect(job).toContain("::error::Set PR_PREVIEW_CLOUDFLARE_API_TOKEN");
  });

  it("reads no Cloudflare token in a job with no environment", () => {
    expect(cloudflareTokensOf(ciJobs.get("check"))).toStrictEqual([]);
    expect(cloudflareTokensOf(ciJobs.get("report-failure"))).toStrictEqual([]);
  });

  it("writes every token to an environment, never to the repository", () => {
    const secrets = stack.match(
      /GitHub\.Secret\("[A-Za-z]*Token",\s*\{[^}]*\}/gu
    );

    expect(secrets).toHaveLength(3);
    expect(secrets?.every((secret) => secret.includes("environment"))).toBe(
      true
    );
  });

  it("keeps Workers routes, DNS and D1 out of the pull request token", () => {
    const policy = stack.slice(
      stack.indexOf('"JobBoardPrPreviewToken"'),
      stack.indexOf('"JobBoardPreviewToken"')
    );

    expect(policy).toContain('"Workers Scripts Write"');
    expect(policy).not.toMatch(/D1|DNS|Routes|Queues|R2|KV|Tail|\.zone\./u);
  });
});

describe("the check job", () => {
  it("runs pull request code with a read-only token that is not left on disk", () => {
    const check = ciJobs.get("check");

    expect(check).toContain("contents: read");
    expect(check).not.toContain("contents: write");
    expect(check).toContain("persist-credentials: false");
    expect(check).not.toContain("GH_TOKEN");
  });

  it("reports failures from a job that checks out and runs nothing", () => {
    const report = ciJobs.get("report-failure");

    expect(report).toContain("contents: write");
    expect(report).toContain("actions/download-artifact");
    expect(report).not.toContain("actions/checkout");
    expect(report).not.toContain("pnpm");
  });
});
