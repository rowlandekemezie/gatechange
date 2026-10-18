import {
  previewWorkerName,
  PROD_STAGE,
  SITE_HOSTNAME,
  SITE_ZONE,
} from "@rat-stack/core";

export const siteRouting = (stage: string) =>
  stage === PROD_STAGE
    ? {
        domain: { name: SITE_HOSTNAME, zoneName: SITE_ZONE },
        workersDev: false,
      }
    : { name: previewWorkerName(stage), workersDev: true };

export const siteIndexing = (stage: string) =>
  stage === PROD_STAGE ? "index" : "noindex";
