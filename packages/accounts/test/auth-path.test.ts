import { describe, expect, it } from "@effect/vitest";

import { isAuthPath } from "../src/index.js";

describe("auth routing", () => {
  it.each([
    "/api/auth",
    "/api/auth?x=1",
    "/api/auth/get-session",
    "/api/auth/magic-link/verify?token=t&callbackURL=/account",
  ])("sends %s to better-auth", (url) => {
    expect(isAuthPath(url)).toBe(true);
  });

  it.each([
    "/rpc",
    "/rpc?next=/api/auth/",
    "/api/authority",
    "/api/auth-x",
    "//evil/api/auth/x",
    String.raw`/\evil/api/auth/x`,
  ])("keeps %s away from better-auth", (url) => {
    expect(isAuthPath(url)).toBe(false);
  });
});
