import type { Feature, MeshQuality } from "../model/types";
import type { CheckResult, ExportResult, StepResult, ThreeMfResult, FromWorker, KernelRequest, KernelResponseBody, RebuildResult, ToWorker } from "./protocol";

/**
 * Main-thread handle on the geometry worker. Every call returns a promise.
 * Rebuilds are "latest wins": while one is running, newer requests replace
 * each other and only the most recent is sent when the worker is free.
 */
export class KernelClient {
  readonly ready: Promise<void>;
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (body: KernelResponseBody) => void; reject: (e: Error) => void }>();

  private rebuildRunning = false;
  private queuedRebuild: { features: Feature[]; variables: Record<string, number>; onDone: (r: RebuildResult | Error) => void } | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor() {
    this.worker = new Worker(new URL("./kernel.worker.ts", import.meta.url), { type: "module", name: "partsmith-geometry" });

    let markReady: () => void;
    let markFailed: (e: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      markFailed = reject;
    });

    this.worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      if (msg.kind === "ready") return markReady();
      if (msg.kind === "fatal") return markFailed(new Error(msg.error));
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.body);
      else waiter.reject(new Error(msg.error));
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "The geometry engine stopped unexpectedly.");
      markFailed(error);
      for (const w of this.pending.values()) w.reject(error);
      this.pending.clear();
    };
  }

  private send(request: KernelRequest): Promise<KernelResponseBody> {
    const id = this.nextId++;
    const message: ToWorker = { id, request };
    return new Promise<KernelResponseBody>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(message);
    });
  }

  /** Ask for a rebuild; `onDone` fires only for the latest request that actually ran. */
  requestRebuild(features: Feature[], variables: Record<string, number>, onDone: (result: RebuildResult | Error) => void): void {
    this.queuedRebuild = { features, variables, onDone };
    if (!this.rebuildRunning) void this.drainRebuilds();
  }

  private async drainRebuilds(): Promise<void> {
    this.rebuildRunning = true;
    while (this.queuedRebuild) {
      const { features, variables, onDone } = this.queuedRebuild;
      this.queuedRebuild = null;
      try {
        const result = (await this.send({ type: "rebuild", features, variables })).result as RebuildResult;
        // Skip stale results if something newer is already waiting.
        if (!this.queuedRebuild) onDone(result);
      } catch (e) {
        if (!this.queuedRebuild) onDone(e instanceof Error ? e : new Error(String(e)));
      }
    }
    this.rebuildRunning = false;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((w) => w());
  }

  /** Resolves once no rebuild is running or waiting, so checks and exports see the latest model. */
  whenIdle(): Promise<void> {
    if (!this.rebuildRunning && !this.queuedRebuild) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  check(quality: MeshQuality): Promise<CheckResult> {
    return this.send({ type: "check", quality }).then((body) => body.result as CheckResult);
  }

  exportStl(partIds: string[], quality: MeshQuality): Promise<ExportResult> {
    return this.send({ type: "exportStl", partIds, quality }).then((body) => body.result as ExportResult);
  }

  export3mf(partIds: string[], quality: MeshQuality, title: string): Promise<ThreeMfResult> {
    return this.send({ type: "export3mf", partIds, quality, title }).then((body) => body.result as ThreeMfResult);
  }

  exportStep(partIds: string[]): Promise<StepResult> {
    return this.send({ type: "exportStep", partIds }).then((body) => body.result as StepResult);
  }

  terminate(): void {
    this.worker.terminate();
  }
}
