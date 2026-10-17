import { toRpcGroup } from "@rat-stack/capability/rpc-group";
import {
  jobBoardContracts,
  MAX_AGE_DAYS,
  MAX_PAGE_SIZE,
} from "@rat-stack/core/contracts";
import type { JobValue } from "@rat-stack/core/contracts";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

export interface ServiceBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}

const { group } = toRpcGroup(jobBoardContracts);

const clientOf = (backend: ServiceBinding) =>
  RpcClient.make(group).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: "https://backend/rpc" }).pipe(
        Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
        Layer.provide(
          Layer.succeed(
            FetchHttpClient.Fetch,
            // @effect-diagnostics-next-line asyncFunction:off -- FetchHttpClient.Fetch takes the platform fetch signature, which returns a Promise.
            async (input, init) => await backend.fetch(new Request(input, init))
          )
        )
      )
    )
  );

export const findJob = (backend: ServiceBinding, id: string) =>
  Effect.scoped(
    Effect.flatMap(clientOf(backend), (client) => client.getJob({ id }))
  );

const SITEMAP_PAGES = 10;

export const listedJobs = (backend: ServiceBinding) =>
  Effect.scoped(
    Effect.gen(function* listedJobsForSitemap() {
      const client = yield* clientOf(backend);
      const jobs: JobValue[] = [];

      for (let page = 0; page < SITEMAP_PAGES; page += 1) {
        const result = yield* client.listJobs({
          limit: MAX_PAGE_SIZE,
          maxAgeDays: MAX_AGE_DAYS,
          offset: page * MAX_PAGE_SIZE,
          regions: [],
          roles: [],
          search: "",
          sort: "Newest",
        });

        jobs.push(...result.jobs);

        if (jobs.length >= result.total || result.jobs.length === 0) {
          break;
        }
      }

      return jobs;
    })
  );
