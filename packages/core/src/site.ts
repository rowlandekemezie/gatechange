import { Option } from "effect";

export const PROD_STAGE = "prod";

export const SITE_HOSTNAME = "jobs.rowlandekemezie.com";

export const SITE_ZONE = "rowlandekemezie.com";

export const SITE_ORIGIN = `https://${SITE_HOSTNAME}`;

export const previewWorkerName = (stage: string) =>
  `jobs-${stage.toLowerCase()}`;

export interface SiteHosts {
  readonly allowedHosts: readonly string[];
  readonly fallbackOrigin: Option.Option<string>;
}

export const siteHostsOf = (
  stage: string,
  localHosts: readonly string[]
): SiteHosts =>
  stage === PROD_STAGE
    ? {
        allowedHosts: [SITE_HOSTNAME],
        fallbackOrigin: Option.some(SITE_ORIGIN),
      }
    : {
        allowedHosts: [
          `${previewWorkerName(stage)}.*.workers.dev`,
          ...localHosts,
        ],
        fallbackOrigin: Option.none(),
      };
