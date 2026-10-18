import { Option, Schema } from "effect";

export const PROD_STAGE = "prod";

export const SITE_HOSTNAME = "jobs.rowlandekemezie.com";

export const SITE_ZONE = "rowlandekemezie.com";

export const SITE_ORIGIN = `https://${SITE_HOSTNAME}`;

const OWN_DOMAINS = [SITE_ZONE, "workers.dev", "localhost", "[::1]"] as const;

const UNSPECIFIED_OR_LOOPBACK = /^(?:0\.0\.0\.0|127\.\d+\.\d+\.\d+)$/u;

const WEB_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

const isOwnHost = (hostname: string) => {
  const host = hostname.replace(/\.+$/u, "");

  return (
    UNSPECIFIED_OR_LOOPBACK.test(host) ||
    OWN_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
  );
};

export const offSiteHref = (url: string): Option.Option<string> => {
  const parsed = URL.parse(url);

  if (parsed === null || !WEB_PROTOCOLS.has(parsed.protocol)) {
    return Option.none();
  }

  const onOurPage = URL.parse(url, `${parsed.protocol}//${SITE_HOSTNAME}/x/`);

  return onOurPage?.href === parsed.href && !isOwnHost(parsed.hostname)
    ? Option.some(parsed.href)
    : Option.none();
};

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
