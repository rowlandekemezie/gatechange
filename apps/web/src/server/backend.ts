import { toRpcGroup } from "@rat-stack/capability/rpc-group";
import {
  jobBoardContracts,
  MAX_AGE_DAYS,
  MAX_PAGE_SIZE,
} from "@rat-stack/core/contracts";
import type { JobValue } from "@rat-stack/core/contracts";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

export interface ServiceBinding {
  readonly fetch: typeof globalThis.fetch;
}

const { group } = toRpcGroup(jobBoardContracts);

const httpOver = (binding: ServiceBinding) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, binding.fetch.bind(binding))
    )
  );

export const clientOf = (backend: ServiceBinding) =>
  RpcClient.make(group).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: "https://backend/rpc" }).pipe(
        Layer.provide([httpOver(backend), RpcSerialization.layerJson])
      )
    )
  );

export const shellOf = (assets: ServiceBinding, origin: string) =>
  HttpClient.get(new URL("/", origin)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.provide(httpOver(assets))
  );

const SITEMAP_PAGES = 30;

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
          salaryFloor: null,
          salaryListed: false,
          search: "",
          seniorities: [],
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
