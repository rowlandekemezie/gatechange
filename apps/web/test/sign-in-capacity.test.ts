import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@effect/vitest";
import { SIGN_IN_EMAIL_CAPACITY_CODE } from "@rat-stack/core/contracts";
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { AuthClient } from "../src/client/account/auth-client.js";
import { Message } from "../src/client/account/message.js";
import { SignInState } from "../src/client/account/model.js";
import { init, update } from "../src/client/account/update.js";

const outcomeOf = (response: Response) =>
  Effect.gen(function* requestALink() {
    const { requestLink } = yield* AuthClient;

    return yield* requestLink("ada@example.com");
  }).pipe(
    Effect.provide(AuthClient.layer),
    Effect.provideService(
      FetchHttpClient.Fetch,
      // @effect-diagnostics-next-line asyncFunction:off -- fetch is Promise-based.
      async () => await Promise.resolve(response)
    )
  );

const refusal = (body: string) => new Response(body, { status: 429 });

describe("a refused sign-in link", () => {
  beforeEach(() => {
    vi.stubGlobal("location", new URL("https://gatechange.dev/account"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("reads a spent site budget from the refusal's code", () =>
    Effect.gen(function* capacity() {
      const outcome = yield* outcomeOf(
        refusal(JSON.stringify({ code: SIGN_IN_EMAIL_CAPACITY_CODE }))
      );

      expect(outcome).toBe("AtCapacity");
    })
  );

  it.effect.each([
    ["another code", JSON.stringify({ code: "TOO_MANY_SIGN_INS" })],
    ["no code", JSON.stringify({ message: "Too many requests" })],
    ["a body that is not JSON", "Too many requests"],
  ] as const)("stays a plain limit with %s", ([_label, body]) =>
    Effect.gen(function* plainLimit() {
      expect(yield* outcomeOf(refusal(body))).toBe("Limited");
    })
  );

  it.effect.each([
    [200, "Sent"],
    [400, "Invalid"],
    [500, "Failed"],
  ] as const)("keeps status %i as %s", ([status, outcome]) =>
    Effect.gen(function* otherStatuses() {
      expect(yield* outcomeOf(new Response("{}", { status }))).toBe(outcome);
    })
  );

  it("tells a visitor who never got a link when to come back", () => {
    const { model } = update(
      init().model,
      Message.CompletedRequestLink({
        email: "ada@example.com",
        outcome: "AtCapacity",
      })
    );

    expect(Schema.is(SignInState.Editing)(model.signIn)).toBe(true);
    expect(model.signIn).toStrictEqual(
      SignInState.Editing({
        email: "ada@example.com",
        problem: Option.some(
          "We have reached today's limit on sign-in emails. Try again tomorrow."
        ),
      })
    );
  });
});
