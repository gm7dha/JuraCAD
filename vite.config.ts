import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// The version shown in the app comes from package.json (see CHANGELOG.md).
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// JuraCAD is served from https://gm7dha.github.io/<repo name>/ (now /JuraCAD/),
// so every asset URL is prefixed with "/<repo name>/". CI passes BASE_PATH from
// the repository's name, so the site keeps working if the repo is renamed.
const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
const wanted = process.env.BASE_PATH || (repo ? `/${repo}/` : "/JuraCAD/");
// Always "/name/", even if BASE_PATH was typed without its slashes.
const base = `/${wanted.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");

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
    // Each test file runs in its own process ("forks"), so the memory a file's
    // OpenCascade engine grabs is freed when that file ends (OpenCascade never
    // gives memory back while its process lives). The heaviest test files use
    // up to ~3 GB; Node's own memory limit is raised so it's never the thing
    // that stops a test.
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--max-old-space-size=4096"] } },
    // Notes each test file's peak memory for tests/support/ciReporter.ts.
    setupFiles: ["tests/support/memory.ts"],
    // Generous, as engine tests slow down a lot when a shared CI machine is busy.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
