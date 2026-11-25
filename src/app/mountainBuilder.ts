import type { MountainJob, MountainReply } from "./mountainPuzzle.worker";

/** How long one build in the worker may take before it's stopped (ms). */
const BUILD_LIMIT_MS = 120_000;

/**
 * Runs Mountain puzzle builds in a worker (`mountainPuzzle.worker.ts`), one at a time: a new build, or `stop`, ends one
 * still running (the worker is ended, so its work really stops). As the Island window's IslandBuilder.
 */
export class MountainBuilder {
  private worker: Worker | null = null;
  private busy = false;
  private next = 1;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  build(job: Omit<MountainJob, "id">, done: (reply: MountainReply) => void) {
    if (this.busy) this.stop();
    if (!this.worker) this.worker = new Worker(new URL("./mountainPuzzle.worker.ts", import.meta.url), { type: "module", name: "juracad-mountain" });
    const id = this.next++;
    this.busy = true;
    const finish = (reply: MountainReply) => {
      this.clearWatchdog();
      this.busy = false;
      done(reply);
    };
    this.worker.onmessage = (e: MessageEvent<MountainReply>) => {
      if (e.data.id === id) finish(e.data);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.stop();
      finish({ id, error: "The puzzle couldn't be made — the browser stopped the work part-way." });
    };
    this.watchdog = setTimeout(() => {
      this.stop();
      finish({ id, error: "Making the puzzle took too long and was stopped." });
    }, BUILD_LIMIT_MS);
    this.worker.postMessage({ ...job, id } satisfies MountainJob);
  }
  stop() {
    this.clearWatchdog();
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
  }
  private clearWatchdog() {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}
