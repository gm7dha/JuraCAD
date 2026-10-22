/**
 * Runs before every test file (vite.config.ts › test.setupFiles). Each test file
 * runs in its own process, so that process's peak memory is the file's peak
 * memory; it's passed to tests/support/ciReporter.ts, which lists it in the CI
 * summary. That makes a file that's growing too big easy to spot.
 */
import { readFileSync } from "node:fs";
import { afterAll } from "vitest";

/** Peak resident memory of this process in MB (Linux), or the current heap elsewhere. */
function peakMemoryMB(): number {
  try {
    const kb = Number(/^VmHWM:\s+(\d+)/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1]);
    if (kb > 0) return Math.round(kb / 1024);
  } catch {
    // Not Linux.
  }
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

afterAll((suite) => {
  (suite as { meta: Record<string, unknown> }).meta.peakMemoryMB = peakMemoryMB();
});
