import { toToolkit } from "@rat-stack/capability/toolkit";
import {
  agentSources,
  CurrentViewer,
  freeAgentCapabilities,
  MCP_PATH,
  ServedSources,
  Viewer,
} from "@rat-stack/core";
import type { BillingStore, JobStore } from "@rat-stack/core";
import { Effect, Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import type { HttpServerResponse } from "effect/http";

export const MCP_SERVER_NAME = "jobs-rowlandekemezie";

export const MCP_SERVER_VERSION = "1.0.0";

const MCP_PROTOCOLS = [McpProtocol.v2026_07_28] as const;

const INSTRUCTIONS =
  "Search engineering leadership roles (managers to CTOs) posted in the last 30 days with listJobs, and read board health with boardStats. Every listing links to its original posting; send applicants there.";

export const agentToolkit = toToolkit(freeAgentCapabilities);

type AgentStores = BillingStore | JobStore;

export const mcpAppLayer = <E, R>(stores: Layer.Layer<AgentStores, E, R>) =>
  McpServer.toolkit(agentToolkit.toolkit).pipe(
    Layer.provide(
      agentToolkit.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            stores,
            Layer.succeed(CurrentViewer, Viewer.Anonymous()),
            Layer.succeed(ServedSources, agentSources())
          )
        )
      )
    ),
    Layer.provideMerge(
      McpServer.layerHttp({
        allowedOrigins: [],
        instructions: INSTRUCTIONS,
        name: MCP_SERVER_NAME,
        path: MCP_PATH,
        protocols: MCP_PROTOCOLS,
        version: MCP_SERVER_VERSION,
      })
    )
  );

export const serveMcp =
  <E, R>(mcpHttp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  () =>
    mcpHttp.pipe(
      Effect.provideService(CurrentViewer, Viewer.Anonymous()),
      Effect.scoped
    );
