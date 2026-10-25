import { describe, expect, it, vi } from "vitest";

import { backendOf } from "../src/server/preview-backend.js";

const destination = "https://pr-17-backend.rowland-ekemezie.workers.dev";

const secret = "a".repeat(64);

const binding = () => ({ fetch: vi.fn<typeof globalThis.fetch>() });

describe("PR backend transport", () => {
  it("keeps the service binding on ordinary stages", () => {
    const backend = binding();
    expect(backendOf({ BACKEND: backend }, binding().fetch)).toBe(backend);
  });

  it.each([
    { PR_PREVIEW_BACKEND_URL: destination },
    { PR_PREVIEW_SECRET: secret },
    { PR_PREVIEW_BACKEND_URL: destination, PR_PREVIEW_SECRET: "short" },
    {
      PR_PREVIEW_BACKEND_URL: "https://other.example",
      PR_PREVIEW_SECRET: secret,
    },
    {
      PR_PREVIEW_BACKEND_URL:
        "http://pr-17-backend.rowland-ekemezie.workers.dev",
      PR_PREVIEW_SECRET: secret,
    },
    {
      PR_PREVIEW_BACKEND_URL: "https://pr-17.evil.rowland-ekemezie.workers.dev",
      PR_PREVIEW_SECRET: secret,
    },
    {
      PR_PREVIEW_BACKEND_URL:
        "https://user@pr-17-backend.rowland-ekemezie.workers.dev",
      PR_PREVIEW_SECRET: secret,
    },
  ])("fails closed for invalid preview configuration %o", (configuration) => {
    expect(
      backendOf({ BACKEND: binding(), ...configuration }, binding().fetch)
    ).toBeUndefined();
  });

  it("forwards body, query, browser origin and cookies, replaces the transport credential and preserves redirects", () => {
    const transport = binding().fetch;

    const preview = backendOf(
      { PR_PREVIEW_BACKEND_URL: destination, PR_PREVIEW_SECRET: secret },
      transport
    );

    const request = new Request(
      "https://pr-17-jobs-preview.rowland-ekemezie.workers.dev/api/auth/sign-in?next=%2Faccount",
      {
        body: "payload",
        headers: {
          cookie: "session=example",
          origin: "https://pr-17-jobs-preview.rowland-ekemezie.workers.dev",
          "x-jobs-preview-secret": "spoofed",
        },
        method: "POST",
      }
    );

    void preview?.fetch(request);
    const sent = transport.mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(Request);

    if (!(sent instanceof Request)) {
      throw new Error("Missing request");
    }

    expect(sent.url).toBe(`${destination}/api/auth/sign-in?next=%2Faccount`);
    expect(sent.method).toBe("POST");
    expect(sent.body).not.toBeNull();
    expect(sent.headers.get("cookie")).toBe("session=example");
    expect(sent.headers.get("origin")).toBe(new URL(request.url).origin);
    expect(sent.headers.get("x-jobs-preview-secret")).toBe(secret);
    expect(sent.redirect).toBe("manual");
  });
});
