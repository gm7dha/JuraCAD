import type { Feature, MeshQuality } from "../model/types";
import type { CheckResult, ExportResult, FromWorker, KernelRequest, KernelResponseBody, RebuildResult, ToWorker } from "./protocol";

type ResultOf<T extends KernelRequest["type"]> = Extract<KernelResponseBody, { type: T }>["result"];

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
  private queuedRebuild: { features: Feature[]; onDone: (r: RebuildResult | Error) => void } | null = null;
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

  private send<T extends KernelRequest["type"]>(request: Extract<KernelRequest, { type: T }>): Promise<ResultOf<T>> {
    const id = this.nextId++;
    const message: ToWorker = { id, request };
    return new Promise<ResultOf<T>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (body) => resolve(body.result as ResultOf<T>),
        reject,
      });
      this.worker.postMessage(message);
    });
  }

  /** Ask for a rebuild; `onDone` fires only for the latest request that actually ran. */
  requestRebuild(features: Feature[], onDone: (result: RebuildResult | Error) => void): void {
    this.queuedRebuild = { features, onDone };
    if (!this.rebuildRunning) void this.drainRebuilds();
  }

  private async drainRebuilds(): Promise<void> {
    this.rebuildRunning = true;
    while (this.queuedRebuild) {
      const { features, onDone } = this.queuedRebuild;
      this.queuedRebuild = null;
      try {
        const result = await this.send({ type: "rebuild", features });
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
    return this.send({ type: "check", quality });
  }

  exportStl(partIds: string[], quality: MeshQuality): Promise<ExportResult> {
    return this.send({ type: "exportStl", partIds, quality });
  }

  terminate(): void {
    this.worker.terminate();
  }
}
