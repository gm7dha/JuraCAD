import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// The version shown in the app comes from package.json (see CHANGELOG.md).
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// JuraCAD is served from https://gm7dha.github.io/<repo name>/ (now /JuraCAD/),
// so every asset URL is prefixed with "/<repo name>/". CI passes BASE_PATH from
// the repository's name, so the site keeps working if the repo is renamed.
const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.BASE_PATH || (repo ? `/${repo}/` : "/JuraCAD/");

export default defineConfig({
  base,
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
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
