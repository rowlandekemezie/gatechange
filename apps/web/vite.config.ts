import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/client",
    rolldownOptions: { external: [/^cloudflare:/u] },
  },
  plugins: [
    foldkit({
      // @effect-diagnostics-next-line cryptoRandomUUID:off -- Vite loads this config once per build or dev server, outside any Effect runtime, so the client and Worker environments share this one id.
      buildId: process.env.FOLDKIT_BUILD_ID ?? globalThis.crypto.randomUUID(),
    }),
  ],
});
