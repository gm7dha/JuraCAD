/**
 * A small Vitest reporter for CI. Used alongside the default reporter:
 *
 *   vitest run --reporter=default --reporter=./tests/support/ciReporter.ts
 *
 * Why: GitHub's job logs aren't always readable, so every failure is also
 * written as a GitHub annotation (the "Annotations" box on the run page).
 * Vitest's own "github-actions" reporter skips errors it can't tie to a line
 * of our code — such as a test process that crashed or ran out of memory —
 * which left some failed runs with no clue at all. This one reports
 * everything, and adds a one-line summary of time and memory per test file
 * (see tests/support/memory.ts) and how low the machine's free memory got.
 *
 * Outside GitHub Actions it only prints the summary.
 */
import { freemem, totalmem } from "node:os";
import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";

// Just the parts of Vitest's task objects used here (kept structural so this
// file doesn't depend on Vitest's internal type names, which change between versions).
interface TaskError {
  name?: string;
  message?: string;
  stack?: string;
}
interface Task {
  name: string;
  type: string;
  mode?: string;
  filepath?: string;
  tasks?: Task[];
  meta?: Record<string, unknown>;
  result?: { state?: string; duration?: number; errors?: TaskError[] };
}

const MB = 1024 * 1024;
/** GitHub shows at most 10 error annotations per step. */
const MAX_ERRORS = 9;

export function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
export function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** The line in `file` an error's stack points at, if any. */
export function lineIn(stack: string | undefined, file: string): number | undefined {
  if (!stack) return undefined;
  for (const l of stack.split("\n")) {
    const at = l.indexOf(file);
    if (at < 0) continue;
    const m = /^:(\d+)(?::\d+)?/.exec(l.slice(at + file.length));
    if (m) return Number(m[1]);
  }
  return undefined;
}

function describeError(e: unknown): TaskError {
  if (e && typeof e === "object") return e as TaskError;
  return { message: String(e) };
}

/** Message plus a few stack lines, short enough to read in an annotation. */
function errorText(e: TaskError, stackLines = 6): string {
  const head = `${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${e.message ?? ""}`.trim();
  const stack = (e.stack ?? "")
    .split("\n")
    .filter((l) => /^\s+at /.test(l))
    .slice(0, stackLines)
    .map((l) => l.trim());
  return [head || "(no message)", ...stack].join("\n");
}

/** A hint for errors that mean a test process died rather than a test failing. */
export function crashHint(text: string): string {
  if (/heap out of memory|Reached heap limit|Cannot enlarge memory|Aborted\(OOM\)|out of memory/i.test(text))
    return "\nThis looks like running out of memory.";
  if (/Worker exited unexpectedly|Channel closed|terminated|SIGKILL|ERR_IPC_CHANNEL_CLOSED/i.test(text))
    return "\nA test process stopped without finishing — usually it ran out of memory (see the memory notice).";
  if (/timed out/i.test(text)) return "\nThe machine may have been busy; see the time summary notice.";
  return "";
}

interface Failure {
  file?: string;
  line?: number;
  title: string;
  text: string;
}

/** Every failed test, failed file (e.g. a crashed process or a failing beforeAll) and unhandled error. */
export function collectFailures(files: Task[], errors: unknown[], root: string): Failure[] {
  const out: Failure[] = [];
  for (const file of files) {
    const path = file.filepath ? relative(root, file.filepath) : file.name;
    const walk = (t: Task, names: string[]) => {
      const here = t === file ? names : [...names, t.name];
      if (t !== file && t.tasks === undefined && t.result?.state === "fail") {
        for (const e of t.result.errors?.length ? t.result.errors : [{ message: "failed" }]) {
          out.push({ file: path, line: lineIn(e.stack, file.filepath ?? path), title: here.join(" › "), text: errorText(e) });
        }
      }
      for (const c of t.tasks ?? []) walk(c, here);
    };
    walk(file, []);
    if (file.result?.state === "fail" && file.result.errors?.length) {
      for (const e of file.result.errors) {
        const text = errorText(e);
        out.push({ file: path, line: lineIn(e.stack, file.filepath ?? path), title: `${path} (whole file)`, text: text + crashHint(text) });
      }
    } else if (file.mode !== "skip" && file.mode !== "todo" && !["pass", "fail", "skip"].includes(file.result?.state ?? "")) {
      out.push({ file: path, title: `${path} didn't finish`, text: `The file ended in state "${file.result?.state ?? "not run"}".` });
    }
  }
  for (const raw of errors) {
    const e = describeError(raw);
    const text = errorText(e, 10);
    out.push({ title: `Unhandled error${e.name ? ` (${e.name})` : ""}`, text: text + crashHint(text) });
  }
  return out;
}

/** Sum of the resident memory of this process's children (the test workers), in bytes. Linux only. */
function childrenRss(): number {
  let total = 0;
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        if (Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]) !== process.pid) continue;
        total += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
      } catch {
        // The process ended while we looked.
      }
    }
  } catch {
    // No /proc (not Linux).
  }
  return total;
}

const gb = (bytes: number) => `${(bytes / 1024 / MB).toFixed(1)} GB`;

export default class CiReporter {
  private root = process.cwd();
  private started = Date.now();
  private lowestFree = freemem();
  private mostInWorkers = 0;
  private timer?: { unref?: () => void };

  onInit(ctx: { config?: { root?: string } }) {
    this.root = ctx?.config?.root ?? this.root;
    this.started = Date.now();
    this.timer = setInterval(() => {
      this.lowestFree = Math.min(this.lowestFree, freemem());
      this.mostInWorkers = Math.max(this.mostInWorkers, childrenRss());
    }, 1000) as unknown as { unref?: () => void };
    // Don't keep Vitest running just for this.
    this.timer.unref?.();
  }

  onFinished(files: Task[] = [], errors: unknown[] = []) {
    if (this.timer) clearInterval(this.timer as Parameters<typeof clearInterval>[0]);
    const github = !!process.env.GITHUB_ACTIONS;

    // Time and memory summary: the slowest files, with each one's peak memory.
    const slowest = [...files]
      .sort((a, b) => (b.result?.duration ?? 0) - (a.result?.duration ?? 0))
      .slice(0, 6)
      .map((f) => {
        const peak = f.meta?.peakMemoryMB;
        const name = f.filepath ? relative(this.root, f.filepath).replace(/^tests\//, "") : f.name;
        return `${name} ${((f.result?.duration ?? 0) / 1000).toFixed(0)} s${typeof peak === "number" ? ` (${(peak / 1024).toFixed(1)} GB)` : ""}`;
      });
    const summary =
      `Tests took ${((Date.now() - this.started) / 1000).toFixed(0)} s. ` +
      `Slowest files: ${slowest.join(", ")}. ` +
      `Test processes used up to ${gb(this.mostInWorkers)} together; ` +
      `free memory went down to ${gb(this.lowestFree)} of ${gb(totalmem())}.`;
    console.log(`\n${summary}\n`);
    if (!github) return;

    const failures = collectFailures(files, errors, this.root);
    for (const f of failures.slice(0, MAX_ERRORS)) {
      const where = f.file ? `file=${escapeProperty(f.file)},${f.line ? `line=${f.line},` : ""}` : "";
      console.log(`::error ${where}title=${escapeProperty(f.title)}::${escapeData(f.text)}`);
    }
    if (failures.length > MAX_ERRORS) {
      console.log(`::error title=More failures::${failures.length - MAX_ERRORS} more failures aren't shown here.`);
    }
    console.log(`::notice title=Test time and memory::${escapeData(summary)}`);
  }
}
