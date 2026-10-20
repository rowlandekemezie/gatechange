import { expect, it } from "@effect/vitest";
import { toRpc } from "@rat-stack/capability/rpc";
import {
  Account,
  CurrentViewer,
  importShortlist,
  noteTrackedJob,
  trackedJobs,
  trackJob,
  untrackJob,
  Viewer,
} from "@rat-stack/core";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { sqlJsJobStore } from "./sqljs-executor.js";

const RpcRequest = Schema.TaggedStruct("Request", {
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  id: Schema.String,
  payload: Schema.Unknown,
  tag: Schema.String,
});

const projection = toRpc([
  trackJob,
  importShortlist,
  noteTrackedJob,
  trackedJobs,
  untrackJob,
]);

const member = Viewer.Member({
  account: Schema.decodeSync(Account)({
    email: "rpc-fixture@example.com",
    id: "rpc-fixture",
    name: "RPC Fixture",
  }),
});

it.effect(
  "serialized tracker RPC refuses oversized new input before any durable write",
  () =>
    Effect.gen(function* rpcValidation() {
      const stores = yield* sqlJsJobStore;

      const server = RpcServer.layerHttp({
        group: projection.group,
        path: "/rpc",
        protocol: "http",
      }).pipe(
        Layer.provide(
          projection.layer.pipe(
            Layer.provide(stores),
            Layer.provide(Layer.succeed(CurrentViewer, member))
          )
        ),
        Layer.provide(RpcSerialization.layerJson)
      );

      const { handler, dispose } = HttpRouter.toWebHandler(server, {
        disableLogger: true,
      });

      yield* Effect.addFinalizer(() => Effect.promise(dispose));

      const snapshot = {
        company: "Acme",
        location: "Remote, Canada",
        title: "Engineering Manager",
        url: "https://jobs.example/1",
      };

      const requests = [
        {
          payload: { jobId: "i".repeat(201), snapshot, stage: "Saved" },
          tag: "trackJob",
        },
        {
          payload: {
            jobs: [{ jobId: "i".repeat(201), snapshot, stage: "Saved" }],
          },
          tag: "importShortlist",
        },
        {
          payload: {
            jobId: "safe",
            snapshot: { ...snapshot, title: "t".repeat(501) },
            stage: "Saved",
          },
          tag: "trackJob",
        },
        {
          payload: { jobId: "safe", notes: "n".repeat(2001) },
          tag: "noteTrackedJob",
        },
      ];

      for (const [index, request] of requests.entries()) {
        const response = yield* Effect.promise(
          // @effect-diagnostics-next-line asyncFunction:off -- HttpRouter exposes a Promise-based Web handler.
          async () =>
            await handler(
              new Request("http://localhost/rpc", {
                body: JSON.stringify(
                  RpcRequest.make({
                    headers: [],
                    id: String(index),
                    ...request,
                  })
                ),
                headers: { "content-type": "application/json" },
                method: "POST",
              })
            )
        );

        const body = yield* Effect.promise(
          // @effect-diagnostics-next-line asyncFunction:off -- Web Response.text is Promise-based.
          async () => await response.text()
        );

        expect(body).toContain('"_tag":"Failure"');
      }

      expect(
        yield* trackedJobs
          .handler({})
          .pipe(
            Effect.provide(stores),
            Effect.provideService(CurrentViewer, member)
          )
      ).toStrictEqual([]);
    })
);
