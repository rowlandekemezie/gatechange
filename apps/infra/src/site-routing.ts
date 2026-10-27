import {
  previewWorkerName,
  PROD_STAGE,
  SITE_HOSTNAME,
  SITE_REDIRECT_HOSTNAMES,
} from "@rat-stack/core";
import { workerFirstPaths } from "@rat-stack/web/edge-routes";

export const siteRouting = (stage: string) =>
  stage === PROD_STAGE
    ? {
        domain: { aliases: [...SITE_REDIRECT_HOSTNAMES], name: SITE_HOSTNAME },
        workersDev: false,
      }
    : { name: previewWorkerName(stage), workersDev: true };

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
