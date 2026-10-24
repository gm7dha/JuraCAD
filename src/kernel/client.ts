import type { EdgeRef, FaceRef, TopoPick } from "../geometry/topoRef";
import type { SketchPlane } from "../sketch/planes";
import type { Feature, MeshQuality, ViewKind } from "../model/types";
import type { BreakOutRequest, SectionRequest } from "../drawing/sections";
import type { CheckResult, ContactMeasure, DeleteFaceBlockers, ExportResult, InstanceInput, Measurement, PartMesh, StepResult, StudioInput, ThreeMfResult, ViewProjection, FromWorker, KernelRequest, KernelResponseBody, RebuildResult, ToWorker } from "./protocol";

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
  private queuedRebuild: { studios: StudioInput[]; variables: Record<string, number>; partNames: Record<string, string>; onDone: (r: RebuildResult | Error) => void } | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor() {
    this.worker = new Worker(new URL("./kernel.worker.ts", import.meta.url), { type: "module", name: "juracad-geometry" });

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
  requestRebuild(
    studios: StudioInput[],
    variables: Record<string, number>,
    partNames: Record<string, string>,
    onDone: (result: RebuildResult | Error) => void,
  ): void {
    this.queuedRebuild = { studios, variables, partNames, onDone };
    if (!this.rebuildRunning) void this.drainRebuilds();
  }

  private async drainRebuilds(): Promise<void> {
    this.rebuildRunning = true;
    // Results skipped because a newer rebuild was waiting: each only holds the
    // Part Studios it rebuilt, so they're carried into the next one.
    let carried: RebuildResult | null = null;
    while (this.queuedRebuild) {
      const { studios, variables, partNames, onDone } = this.queuedRebuild;
      this.queuedRebuild = null;
      try {
        const fresh = (await this.send({ type: "rebuild", studios, variables, partNames })).result as RebuildResult;
        const result: RebuildResult = carried ? mergeRebuilds(carried, fresh) : fresh;
        carried = null;
        // Skip stale results if something newer is already waiting.
        if (!this.queuedRebuild) onDone(result);
        else carried = result;
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

  check(quality: MeshQuality, partIds: string[] = []): Promise<CheckResult> {
    return this.send({ type: "check", quality, partIds }).then((body) => body.result as CheckResult);
  }

  exportStl(partIds: string[], quality: MeshQuality, instances?: InstanceInput[]): Promise<ExportResult> {
    return this.send({ type: "exportStl", partIds, quality, instances }).then((body) => body.result as ExportResult);
  }

  export3mf(partIds: string[], quality: MeshQuality, title: string, colours?: Record<string, string>, instances?: InstanceInput[]): Promise<ThreeMfResult> {
    return this.send({ type: "export3mf", partIds, quality, title, colours, instances }).then((body) => body.result as ThreeMfResult);
  }

  /** Whole parts: their sizes, and the gap and overlap between two of them. */
  measureParts(partIds: string[]): Promise<Measurement> {
    return this.send({ type: "measureParts", partIds }).then((body) => body.result as Measurement);
  }

  /** A sheet metal part laid out flat, as a mesh to show in place of the folded one (null if it can't be). */
  unfold(partId: string): Promise<PartMesh | null> {
    return this.send({ type: "unfold", partId }).then((body) => (body.type === "unfold" ? body.result : null));
  }

  /** Intersect: where a sketch's plane cuts a part (or one face of it), as edges to bring into the sketch. */
  intersect(partId: string, plane: SketchPlane, face?: FaceRef): Promise<{ edges: EdgeRef[] } | { error: string }> {
    return this.send({ type: "intersect", partId, plane, face }).then((body) => (body.type === "intersect" ? body.result : { error: "Something went wrong working out where the sketch cuts the part." }));
  }

  measure(picks: TopoPick[]): Promise<Measurement> {
    return this.send({ type: "measure", picks }).then((body) => body.result as Measurement);
  }

  /** Which fillets / chamfers stop a Delete face working (see GeometryEngine.deleteFaceBlockers). */
  deleteFaceBlockers(features: Feature[], featureId: string, variables: Record<string, number>): Promise<DeleteFaceBlockers> {
    return this.send({ type: "deleteFaceBlockers", features, featureId, variables }).then((body) => body.result as DeleteFaceBlockers);
  }

  exportStep(partIds: string[], colours?: Record<string, string>, instances?: InstanceInput[]): Promise<StepResult> {
    return this.send({ type: "exportStep", partIds, colours, instances }).then((body) => body.result as StepResult);
  }

  /** Drawing views of parts (or an assembly's placed copies). */
  project(partIds: string[], instances: InstanceInput[] | undefined, views: ViewKind[], hidden: boolean, sections: SectionRequest[] = [], breakouts: BreakOutRequest[] = [], tangent = true): Promise<ViewProjection[]> {
    return this.send({ type: "project", partIds, instances, views, hidden, sections, breakouts, tangent }).then((body) => body.result as ViewProjection[]);
  }

  /** How pairs of assembly instances meet: overlapping, or (`withGaps`) within `tolerance` (mm) of each other. */
  clashes(instances: InstanceInput[], tolerance = 0, withGaps = true): Promise<ContactMeasure[]> {
    return this.send({ type: "clashes", instances, tolerance, withGaps }).then((body) => body.result as ContactMeasure[]);
  }

  terminate(): void {
    this.worker.terminate();
  }
}

/** An earlier rebuild's parts for Part Studios a later one didn't rebuild, plus the later one's. */
export function mergeRebuilds(earlier: RebuildResult, later: RebuildResult): RebuildResult {
  if (!later.rebuilt || !earlier.rebuilt) return later;
  const order = later.studioOrder ?? [];
  const keep = earlier.rebuilt.filter((id) => !later.rebuilt!.includes(id) && order.includes(id));
  return {
    ...later,
    rebuilt: [...later.rebuilt, ...keep],
    parts: [...later.parts, ...earlier.parts.filter((p) => keep.includes(p.studioId ?? "main"))],
  };
}
