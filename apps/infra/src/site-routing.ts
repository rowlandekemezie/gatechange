import {
  PREVIEW_STAGE,
  previewWorkerName,
  PROD_STAGE,
  SITE_HOSTNAME,
  SITE_REDIRECT_HOSTNAMES,
  UAT_HOSTNAME,
} from "@rat-stack/core";
import { workerFirstPaths } from "@rat-stack/web/edge-routes";

export const siteRouting = (stage: string) => {
  if (stage === PROD_STAGE) {
    return {
      domain: { aliases: [...SITE_REDIRECT_HOSTNAMES], name: SITE_HOSTNAME },
      workersDev: false,
    };
  }

  const workers = { name: previewWorkerName(stage), workersDev: true };

  return stage === PREVIEW_STAGE
    ? { ...workers, domain: { name: UAT_HOSTNAME } }
    : workers;
};

export const siteIndexing = (stage: string) =>
  stage === PROD_STAGE ? "index" : "noindex";

export const siteWorkerFirst = (stage: string) =>
  stage === PROD_STAGE
    ? [
        ...workerFirstPaths,
        "/",
        "/pricing",
        "/about",
        "/privacy",
        "/terms",
        "/contact",
        "/jobs/*",
        "/companies/*",
        "/roles/*",
        "/sitemap.xml",
        "/robots.txt",
      ]
    : true;
