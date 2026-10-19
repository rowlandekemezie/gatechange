import { toRpcGroup } from "@rat-stack/capability/rpc-group";
import { jobBoardContracts } from "@rat-stack/core/contracts";
import type {
  AgentTokenIdValue,
  JobQueryValue,
  PlanValue,
  SavedSearchIdValue,
  SearchFiltersValue,
  TrackRequestValue,
} from "@rat-stack/core/contracts";
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
    agentTokens: client.agentTokens({}),
    deleteSearch: (id: SavedSearchIdValue) => client.deleteSearch({ id }),
    getJob: (id: string) => client.getJob({ id }),
    importShortlist: (jobs: readonly TrackRequestValue[]) =>
      client.importShortlist({ jobs }),
    issueAgentToken: (label: string) => client.issueAgentToken({ label }),
    listJobs: (query: JobQueryValue) => client.listJobs(query),
    membership: client.membership({}),
    noteTrackedJob: (jobId: string, notes: string) =>
      client.noteTrackedJob({ jobId, notes }),
    openBillingPortal: client.openBillingPortal({}),
    revokeAgentToken: (id: AgentTokenIdValue) =>
      client.revokeAgentToken({ id }),
    saveSearch: (filters: SearchFiltersValue) => client.saveSearch({ filters }),
    savedSearches: client.savedSearches({}),
    setInstantAlerts: (enabled: boolean) =>
      client.setInstantAlerts({ enabled }),
    signInOptions: client.signInOptions({}),
    startCheckout: (plan: PlanValue) => client.startCheckout({ plan }),
    stats: client.boardStats({}),
    trackJob: (job: TrackRequestValue) => client.trackJob(job),
    trackedJobs: client.trackedJobs({}),
    untrackJob: (jobId: string) => client.untrackJob({ jobId }),
  };
});

export class JobQueries extends Context.Service<
  JobQueries,
  Effect.Success<typeof make>
>()("@rat-stack/web/JobQueries", { make }) {
  static readonly layer = Layer.effect(this, this.make);
}
