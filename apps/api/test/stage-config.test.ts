import { describe, expect, it } from "@effect/vitest";
import { publicOriginOf, siteHostsOf, sweepLimitOf } from "@rat-stack/core";
import { ConfigProvider, Effect, Option } from "effect";

import { stageConfig } from "../src/stage-config.js";

const configured = (stage: string, values: Record<string, string> = {}) =>
  stageConfig(stage).parse(ConfigProvider.fromUnknown(values));

const previewOrigin = "https://jobs-preview.rowland-ekemezie.workers.dev";

describe("persistent preview defaults", () => {
  it.effect(
    "keeps PR resource spending disabled even with explicit overrides",
    () =>
      Effect.gen(function* pullRequestDefaults() {
        const config = yield* configured("pr-7", {
          BILLING_ENABLED: "true",
          DIGEST_DAILY_SEND_LIMIT: "50",
          DIGEST_SENDS_PER_RUN: "25",
          ENRICHMENT_DAILY_NEURONS: "29000",
        });

        expect(config.billingEnabled).toBe(false);
        expect(config.dailyNeurons).toBe(0);
        expect(config.digestDailySendLimit).toBe(0);
        expect(config.digestSendsPerRun).toBe(0);
        expect(config.magicLinkDailySendLimit).toBe(10);
        expect(config.digestSiteOrigin).toBe(
          "https://pr-7-jobs-preview.rowland-ekemezie.workers.dev"
        );
        expect(config.subdomain).toStrictEqual(Option.some("rowland-ekemezie"));
      })
  );

  it.effect("uses its own trusted origin and bounded mail and AI budgets", () =>
    Effect.gen(function* previewDefaults() {
      const config = yield* configured("preview");

      expect(config).toStrictEqual({
        billingEnabled: true,
        dailyNeurons: 0,
        digestDailySendLimit: 5,
        digestSendsPerRun: 1,
        digestSiteOrigin: previewOrigin,
        magicLinkDailySendLimit: 10,
        proPlans: [],
        subdomain: Option.some("rowland-ekemezie"),
      });
      expect(publicOriginOf("preview", config.subdomain)).toStrictEqual(
        Option.some(previewOrigin)
      );
      expect(
        siteHostsOf("preview", {
          localHosts: [],
          workersSubdomain: config.subdomain,
        }).allowedHosts
      ).toStrictEqual([new URL(previewOrigin).host]);
      expect(
        sweepLimitOf({ configured: Option.none(), stage: "preview" })
      ).toBe(0);
    })
  );

  it.effect.each(["prod", "dev", "verify-x", "Preview", "production"])(
    "preserves defaults for exact stage %s",
    (stage) =>
      Effect.gen(function* otherStages() {
        const config = yield* configured(stage);

        expect(config).toStrictEqual({
          billingEnabled: false,
          dailyNeurons: 29_000,
          digestDailySendLimit: 50,
          digestSendsPerRun: 25,
          digestSiteOrigin: "https://jobs.rowlandekemezie.com",
          magicLinkDailySendLimit: 900,
          proPlans: [],
          subdomain: Option.none(),
        });
        expect(
          siteHostsOf(stage, {
            localHosts: [],
            workersSubdomain: config.subdomain,
          }).allowedHosts
        ).toStrictEqual(stage === "prod" ? ["jobs.rowlandekemezie.com"] : []);
      })
  );

  it.effect(
    "honors explicit overrides including disabling preview billing",
    () =>
      Effect.gen(function* explicitOverrides() {
        const config = yield* configured("preview", {
          BILLING_ENABLED: "false",
          DIGEST_DAILY_SEND_LIMIT: "0",
          DIGEST_SENDS_PER_RUN: "0",
          DIGEST_SITE_ORIGIN: "https://preview.example.test",
          ENRICHMENT_DAILY_NEURONS: "12",
          MAGIC_LINK_DAILY_SEND_LIMIT: "0",
          WORKERS_SUBDOMAIN: "rowland-ekemezie",
        });

        expect(config).toStrictEqual({
          billingEnabled: false,
          dailyNeurons: 12,
          digestDailySendLimit: 0,
          digestSendsPerRun: 0,
          digestSiteOrigin: "https://preview.example.test",
          magicLinkDailySendLimit: 0,
          proPlans: [],
          subdomain: Option.some("rowland-ekemezie"),
        });
        expect(
          sweepLimitOf({ configured: Option.some(2), stage: "preview" })
        ).toBe(2);
        expect(
          (yield* configured("prod", { BILLING_ENABLED: "true" }))
            .billingEnabled
        ).toBe(true);
      })
  );

  it.effect("reads PRO_PLANS and treats an empty value as no plans", () =>
    Effect.gen(function* proPlans() {
      const weekly = yield* configured("preview", {
        PRO_PLANS: '[{"plan":"Weekly","amountCents":500,"interval":"week"}]',
      });

      const empty = yield* configured("preview", { PRO_PLANS: "" });

      expect(weekly.proPlans).toStrictEqual([
        {
          amountCents: 500,
          interval: "week",
          intervalCount: 1,
          onSale: true,
          plan: "Weekly",
        },
      ]);
      expect(empty.proPlans).toStrictEqual([]);
    })
  );

  it.effect("refuses a PRO_PLANS value that is not valid plan JSON", () =>
    configured("preview", { PRO_PLANS: '{"plan":"Weekly"}' }).pipe(
      Effect.flip,
      Effect.asVoid
    )
  );

  it.effect("refuses a mismatched preview account instead of hiding it", () =>
    configured("preview", { WORKERS_SUBDOMAIN: "other-account" }).pipe(
      Effect.flip,
      Effect.tap((failure) =>
        Effect.sync(() => {
          expect(failure.message).toContain("SITE_WORKERS_SUBDOMAIN");
        })
      ),
      Effect.asVoid
    )
  );
});
