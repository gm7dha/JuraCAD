import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// PartSmith is served from https://gm7dha.github.io/partsmith/, so every
// asset URL is prefixed with /partsmith/.
export default defineConfig({
  base: "/partsmith/",
  plugins: [react()],
  worker: {
    // The geometry worker uses ES module imports (OpenCascade, replicad).
    format: "es",
  },
  build: {
    target: "es2022",
    // The OpenCascade engine is large by nature; don't warn about it.
    chunkSizeWarningLimit: 4000,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Loading the OpenCascade engine takes a few seconds in CI.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
