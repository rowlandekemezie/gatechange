import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/client",
    rolldownOptions: { external: [/^cloudflare:/u] },
  },
  plugins: [
    foldkit({
      // @effect-diagnostics-next-line cryptoRandomUUID:off -- Vite config runs outside Effect; this one id per process is what the client and Worker builds share.
      buildId: process.env.FOLDKIT_BUILD_ID ?? globalThis.crypto.randomUUID(),
    }),
  ],
});
