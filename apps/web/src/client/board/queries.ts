import { toRpcGroup } from "@rat-stack/capability/rpc-group";
import { jobBoardContracts } from "@rat-stack/core/contracts";
import type {
  AgentTokenIdValue,
  JobQueryValue,
  PlanValue,
  SavedSearchIdValue,
  SearchFiltersValue,
  TrackRequestValue,
  TrackOrMoveRequestValue,
} from "@rat-stack/core/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

const { group } = toRpcGroup(jobBoardContracts);

const checkedHttp = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* checkStatus() {
    return HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  })
).pipe(Layer.provide(FetchHttpClient.layer));

const protocol = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide([checkedHttp, RpcSerialization.layerJson])
);

export const isRateLimited = Schema.is(
  Schema.Struct({
    reason: Schema.Struct({
      cause: Schema.Struct({
        response: Schema.Struct({ status: Schema.Literal(429) }),
      }),
    }),
  })
);

const make = Effect.gen(function* makeJobQueries() {
  const client = yield* RpcClient.make(group).pipe(Effect.provide(protocol));

  return {
    agentTokens: client.agentTokens({}),
    companyIntel: (slug: string) => client.companyIntel({ slug }),
    companyJobs: (slug: string) => client.companyJobs({ slug }),
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
    proPlans: client.proPlans({}),
    revokeAgentToken: (id: AgentTokenIdValue) =>
      client.revokeAgentToken({ id }),
    saveSearch: (filters: SearchFiltersValue) => client.saveSearch({ filters }),
    savedSearches: client.savedSearches({}),
    setInstantAlerts: (enabled: boolean) =>
      client.setInstantAlerts({ enabled }),
    signInOptions: client.signInOptions({}),
    startCheckout: (plan: PlanValue) => client.startCheckout({ plan }),
    stats: client.boardStats({}),
    trackJob: (job: TrackOrMoveRequestValue) => client.trackJob(job),
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
