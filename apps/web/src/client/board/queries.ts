import { toRpcGroup } from "@rat-stack/capability/rpc-group";
import { jobBoardContracts } from "@rat-stack/core/contracts";
import type { JobQueryValue } from "@rat-stack/core/contracts";
import { Context, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

const { group } = toRpcGroup(jobBoardContracts);

const protocol = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson])
);

const make = Effect.gen(function* makeJobQueries() {
  const client = yield* RpcClient.make(group).pipe(Effect.provide(protocol));

  return {
    getJob: (id: string) => client.getJob({ id }),
    listJobs: (query: JobQueryValue) => client.listJobs(query),
    stats: client.boardStats({}),
  };
});

export class JobQueries extends Context.Service<
  JobQueries,
  Effect.Success<typeof make>
>()("@rat-stack/web/JobQueries", { make }) {
  static readonly layer = Layer.effect(this, this.make);
}
