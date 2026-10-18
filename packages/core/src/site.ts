import { Option, Schema } from "effect";

export const PROD_STAGE = "prod";

export const SITE_HOSTNAME = "jobs.rowlandekemezie.com";

export const SITE_ZONE = "rowlandekemezie.com";

export const SITE_ORIGIN = `https://${SITE_HOSTNAME}`;

export const WorkersSubdomain = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u)
);

export const previewWorkerName = (stage: string) =>
  `jobs-${stage.toLowerCase()}`;

export interface SiteHosts {
  readonly allowedHosts: readonly string[];
  readonly fallbackOrigin: Option.Option<string>;
}

export interface StageHosts {
  readonly localHosts: readonly string[];
  readonly workersSubdomain: Option.Option<typeof WorkersSubdomain.Type>;
}

export const siteHostsOf = (
  stage: string,
  { localHosts, workersSubdomain }: StageHosts
): SiteHosts =>
  stage === PROD_STAGE
    ? {
        allowedHosts: [SITE_HOSTNAME],
        fallbackOrigin: Option.some(SITE_ORIGIN),
      }
    : {
        allowedHosts: [
          ...workersSubdomain.pipe(
            Option.map(
              (subdomain) =>
                `${previewWorkerName(stage)}.${subdomain}.workers.dev`
            ),
            Option.toArray
          ),
          ...localHosts,
        ],
        fallbackOrigin: Option.none(),
      };
