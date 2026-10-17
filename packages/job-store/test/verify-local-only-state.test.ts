// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test runs the verify skill's standalone Node script as down.sh does, with a state row on stdin.
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "@effect/vitest";

const script = new URL(
  "../../../.claude/skills/verify/scripts/local-only-state.ts",
  import.meta.url
).pathname;

interface StateRowFixture {
  readonly attr?: Readonly<Record<string, string>>;
  readonly bindings?: readonly string[];
  readonly deleteFirst?: boolean;
  readonly old?: StateRowFixture;
  readonly props: Readonly<Record<string, string>>;
  readonly providerMode?: string;
  readonly status?: string;
}

const accepts = (row: StateRowFixture) =>
  spawnSync(process.execPath, [script, "JobBoard/verify-test/Row"], {
    input: JSON.stringify(row),
  }).status === 0;

const props = { name: "jobs" };

describe("verify skill local-only state guard", () => {
  it("accepts a row alchemy dev stamped local", () => {
    expect(
      accepts({ attr: {}, props, providerMode: "local", status: "created" })
    ).toBe(true);
  });

  it("refuses a row a deploy stamped live", () => {
    expect(
      accepts({ attr: {}, props, providerMode: "live", status: "created" })
    ).toBe(false);
  });

  it("refuses an unstamped row, which alchemy treats as live", () => {
    expect(accepts({ attr: {}, props, status: "created" })).toBe(false);
  });

  it("refuses a local replacement whose old generation is live", () => {
    expect(
      accepts({
        deleteFirst: false,
        old: { attr: {}, props, providerMode: "live", status: "created" },
        props,
        providerMode: "local",
        status: "replacing",
      })
    ).toBe(false);
  });

  it("accepts a local row whose dev run died mid-update", () => {
    expect(
      accepts({
        old: { attr: {}, bindings: [], props },
        props,
        providerMode: "local",
        status: "updating",
      })
    ).toBe(true);
  });

  it("refuses a row with a status it does not recognize", () => {
    expect(accepts({ props, providerMode: "local", status: "adopting" })).toBe(
      false
    );
  });
});
