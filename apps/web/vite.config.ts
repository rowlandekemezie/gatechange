import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

const buildIdFor = (command: "build" | "serve") => {
  if (process.env.FOLDKIT_BUILD_ID !== undefined) {
    return process.env.FOLDKIT_BUILD_ID;
  }

  if (command === "serve") {
    return "development";
  }

  // @effect-diagnostics-next-line cryptoRandomUUID:off -- Vite config runs outside Effect; this one id per build process is what the client and Worker builds share.
  return globalThis.crypto.randomUUID();
};

export default defineConfig(({ command }) => ({
  build: {
    outDir: "dist/client",
    rolldownOptions: { external: [/^cloudflare:/u] },
  },
  plugins: [foldkit({ buildId: buildIdFor(command) })],
}));
