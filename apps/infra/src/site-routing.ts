export const SITE_HOSTNAME = "jobs.rowlandekemezie.com";

export const SITE_ZONE = "rowlandekemezie.com";

export const PROD_STAGE = "prod";

export const siteRouting = (stage: string) =>
  stage === PROD_STAGE
    ? {
        domain: { name: SITE_HOSTNAME, zoneName: SITE_ZONE },
        workersDev: false,
      }
    : { workersDev: true };

export const siteIndexing = (stage: string) =>
  stage === PROD_STAGE ? "index" : "noindex";
