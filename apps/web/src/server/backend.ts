import { toRpcGroup } from "@rat-stack/capability/rpc-group";
import { jobBoardContracts } from "@rat-stack/core/contracts";
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

export const sitemapJobs = (backend: ServiceBinding) =>
  Effect.scoped(
    Effect.flatMap(clientOf(backend), (client) => client.sitemapJobs({}))
  );
