import { Option, Schema } from "effect";

export const PROD_STAGE = "prod";

export const SITE_HOSTNAME = "gatechange.dev";

export const SITE_ORIGIN = `https://${SITE_HOSTNAME}`;

export const LEGACY_SITE_HOSTNAME = "jobs.rowlandekemezie.com";

export const SITE_REDIRECT_HOSTNAMES: readonly string[] = [
  LEGACY_SITE_HOSTNAME,
  `www.${SITE_HOSTNAME}`,
];

export const MAIL_HOSTNAME = LEGACY_SITE_HOSTNAME;

const OWNER_ZONE = "rowlandekemezie.com";

export const canonicalSiteUrlOf = (url: URL): Option.Option<URL> =>
  SITE_REDIRECT_HOSTNAMES.includes(url.hostname.replace(/\.+$/u, ""))
    ? Option.some(new URL(`${url.pathname}${url.search}`, SITE_ORIGIN))
    : Option.none();

export const SITE_NAME = "Gate Change";

export const SOURCE_REPOSITORY_URL = "https://github.com/rowlandekemezie/jobs";

export const OWNER_WORKERS_SUBDOMAIN = "rowland-ekemezie";

declare const __WORKERS_SUBDOMAIN__: string | undefined;

export const siteWorkersSubdomainOf = (configured: string | undefined) =>
  configured === undefined || configured === ""
    ? OWNER_WORKERS_SUBDOMAIN
    : configured;

export const SITE_WORKERS_SUBDOMAIN = siteWorkersSubdomainOf(
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Bundlers replace this build-time define; Node, which has no define, reads WORKERS_SUBDOMAIN from its environment instead.
  typeof __WORKERS_SUBDOMAIN__ === "string"
    ? __WORKERS_SUBDOMAIN__
    : globalThis.process?.env.WORKERS_SUBDOMAIN
);

const DNS_NAME = /^[a-z0-9.-]+$/u;

const IPV4_LITERAL = /^[0-9.]+$/u;

const WEB_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

const isOffSiteName = (hostname: string, workersSubdomain: string) => {
  const host = hostname.replace(/\.+$/u, "");

  return (
    DNS_NAME.test(host) &&
    !IPV4_LITERAL.test(host) &&
    ![
      SITE_HOSTNAME,
      OWNER_ZONE,
      `${workersSubdomain}.workers.dev`,
      "localhost",
    ].some((domain) => host === domain || host.endsWith(`.${domain}`))
  );
};

export const offSiteHrefOn =
  (workersSubdomain: string) =>
  (url: string): Option.Option<string> => {
    const parsed = URL.parse(url);

    if (parsed === null || !WEB_PROTOCOLS.has(parsed.protocol)) {
      return Option.none();
    }

    const onOurPage = URL.parse(url, `${parsed.protocol}//${SITE_HOSTNAME}/x/`);

    return onOurPage?.href === parsed.href &&
      isOffSiteName(parsed.hostname, workersSubdomain)
      ? Option.some(parsed.href)
      : Option.none();
  };

export const offSiteHref = offSiteHrefOn(SITE_WORKERS_SUBDOMAIN);

export const WorkersSubdomain = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u)
);

export const isPullRequestStage = (stage: string) =>
  /^pr-[1-9][0-9]*$/u.test(stage);

export const previewWorkerName = (stage: string) =>
  isPullRequestStage(stage)
    ? `${stage}-jobs-preview`
    : `jobs-${stage.toLowerCase()}`;

export const publicOriginOf = (
  stage: string,
  workersSubdomain: Option.Option<string>
): Option.Option<string> =>
  stage === PROD_STAGE
    ? Option.some(SITE_ORIGIN)
    : workersSubdomain.pipe(
        Option.map(
          (subdomain) =>
            `https://${previewWorkerName(stage)}.${subdomain}.workers.dev`
        )
      );

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
