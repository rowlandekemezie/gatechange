import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { inboxOf } from "../src/email-send-limit.js";

const Letters = Schema.Array(Schema.Literals(["a", "b", "x", "1", ".", "_"]));

const Local = Letters.check(Schema.isMinLength(1));

const Domain = Schema.Literals([
  "gmail.com",
  "googlemail.com",
  "corp.com",
  "example.org",
  "proton.me",
]);

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

describe("inbox budget key", () => {
  it.prop(
    "folds every +tag onto its base address on every domain",
    { domain: Domain, local: Local, tag: Letters },
    ({ domain, local, tag }) => {
      const base = local.join("");

      expect(inboxOf(`${base}+${tag.join("")}@${domain}`)).toBe(
        inboxOf(`${base}@${domain}`)
      );
    }
  );

  it.prop(
    "ignores letter case in the whole address",
    { domain: Domain, local: Local, tag: Letters },
    ({ domain, local, tag }) => {
      const address = `${local.join("")}+${tag.join("")}@${domain}`;

      expect(inboxOf(address.toUpperCase())).toBe(inboxOf(address));
    }
  );

  it.prop(
    "folds dots only on Gmail, and keeps every other base address apart",
    { domain: Domain, left: Local, right: Local },
    ({ domain, left, right }) => {
      const strip = (local: readonly string[]) =>
        GMAIL.has(domain) ? local.join("").replaceAll(".", "") : local.join("");

      expect(
        inboxOf(`${left.join("")}@${domain}`) ===
          inboxOf(`${right.join("")}@${domain}`)
      ).toBe(strip(left) === strip(right));
    }
  );

  it.prop(
    "counts Gmail and Googlemail spellings as one inbox, and other domains apart",
    { local: Local, other: Domain },
    ({ local, other }) => {
      const base = local.join("");

      expect(inboxOf(`${base}@googlemail.com`)).toBe(
        inboxOf(`${base}@gmail.com`)
      );
      expect(inboxOf(`${base}@${other}`) === inboxOf(`${base}@gmail.com`)).toBe(
        GMAIL.has(other)
      );
    }
  );
});
