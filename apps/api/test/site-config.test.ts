import { describe, expect, it } from "@effect/vitest";
import { offSiteHref, publicOriginOf, siteHostsOf } from "@rat-stack/core";
import { ConfigProvider, Effect, Option } from "effect";

import { workersSubdomain } from "../src/site-config.js";

const configured = (values: Record<string, string>) =>
  workersSubdomain.parse(ConfigProvider.fromUnknown(values));

describe("preview account configuration", () => {
  it.effect("refuses a renamed account before trusting an own-host link", () =>
    Effect.gen(function* mismatchedAccount() {
      const failure = yield* configured({
        WORKERS_SUBDOMAIN: "renamed-account",
      }).pipe(Effect.flip);

      expect(failure.message).toContain(
        "WORKERS_SUBDOMAIN must match SITE_WORKERS_SUBDOMAIN"
      );
    })
  );

  it.effect.each(["Acct", "acct.evil", "*", "-acct"])(
    "rejects invalid subdomain %s before runtime trust",
    (value) =>
      configured({ WORKERS_SUBDOMAIN: value }).pipe(Effect.flip, Effect.asVoid)
  );

  it.effect("uses one account for runtime trust and apply-link exclusion", () =>
    Effect.gen(function* sameAccount() {
      const subdomain = yield* configured({
        WORKERS_SUBDOMAIN: "rowland-ekemezie",
      });

      const hosts = siteHostsOf("verify-x", {
        localHosts: [],
        workersSubdomain: subdomain,
      });

      const origin = Option.getOrThrow(publicOriginOf("verify-x", subdomain));
      expect(hosts.allowedHosts).toStrictEqual([new URL(origin).host]);
      expect(
        offSiteHref(`${origin}/api/auth/magic-link/verify?token=synthetic`)
      ).toStrictEqual(Option.none());
      expect(offSiteHref("https://someone.workers.dev/jobs/1")).toStrictEqual(
        Option.some("https://someone.workers.dev/jobs/1")
      );
    })
  );

  it.effect(
    "keeps unset preview trust closed and production defaults fixed",
    () =>
      Effect.gen(function* unchangedDefaults() {
        const subdomain = yield* configured({});
        const blank = yield* configured({ WORKERS_SUBDOMAIN: "" });

        expect(blank).toStrictEqual(subdomain);
        expect(subdomain).toStrictEqual(Option.none());
        expect(
          siteHostsOf("verify-x", {
            localHosts: [],
            workersSubdomain: subdomain,
          }).allowedHosts
        ).toStrictEqual([]);
        expect(
          siteHostsOf("prod", { localHosts: [], workersSubdomain: subdomain })
            .allowedHosts
        ).toStrictEqual(["jobs.rowlandekemezie.com"]);
      })
  );
});
