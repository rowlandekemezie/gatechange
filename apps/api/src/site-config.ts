import { SITE_WORKERS_SUBDOMAIN, WorkersSubdomain } from "@rat-stack/core";
import { Config, Schema } from "effect";

export const workersSubdomain = Config.option(
  Config.schema(
    WorkersSubdomain.check(
      Schema.makeFilter((value) =>
        value === SITE_WORKERS_SUBDOMAIN
          ? undefined
          : `WORKERS_SUBDOMAIN must match SITE_WORKERS_SUBDOMAIN (${SITE_WORKERS_SUBDOMAIN}); update the shared site account before deploying under another account`
      )
    ),
    "WORKERS_SUBDOMAIN"
  )
);
