import { DEFAULT_MAGIC_LINK_DAILY_SEND_LIMIT } from "@rat-stack/accounts";
import {
  DEFAULT_DAILY_NEURONS,
  publicOriginOf,
  SITE_ORIGIN,
  SITE_WORKERS_SUBDOMAIN,
} from "@rat-stack/core";
import { Config, Option } from "effect";

import { workersSubdomain } from "./site-config.js";

export const DEFAULT_DIGEST_SENDS_PER_RUN = 25;

export const DEFAULT_DIGEST_DAILY_SEND_LIMIT = 50;

export const stageConfig = (stage: string) => {
  const preview = stage === "preview";
  const previewSubdomain = Option.some(SITE_WORKERS_SUBDOMAIN);

  return Config.all({
    billingEnabled: Config.Boolean("BILLING_ENABLED").pipe(
      Config.withDefault(preview)
    ),
    dailyNeurons: Config.Int("ENRICHMENT_DAILY_NEURONS").pipe(
      Config.withDefault(preview ? 0 : DEFAULT_DAILY_NEURONS)
    ),
    digestDailySendLimit: Config.Int("DIGEST_DAILY_SEND_LIMIT").pipe(
      Config.withDefault(preview ? 5 : DEFAULT_DIGEST_DAILY_SEND_LIMIT)
    ),
    digestSendsPerRun: Config.Int("DIGEST_SENDS_PER_RUN").pipe(
      Config.withDefault(preview ? 1 : DEFAULT_DIGEST_SENDS_PER_RUN)
    ),
    digestSiteOrigin: Config.String("DIGEST_SITE_ORIGIN").pipe(
      Config.withDefault(
        preview
          ? Option.getOrThrow(publicOriginOf(stage, previewSubdomain))
          : SITE_ORIGIN
      )
    ),
    magicLinkDailySendLimit: Config.Int("MAGIC_LINK_DAILY_SEND_LIMIT").pipe(
      Config.withDefault(preview ? 10 : DEFAULT_MAGIC_LINK_DAILY_SEND_LIMIT)
    ),
    subdomain: workersSubdomain.pipe(
      Config.map((configured) =>
        preview ? Option.orElse(configured, () => previewSubdomain) : configured
      )
    ),
  });
};
