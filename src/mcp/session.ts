/**
 * The design Claude is working on: the document (exactly what a .juracad file
 * holds), its undo history, and the geometry engine that builds it.
 */
import type { SketchLinkInfo } from "../sketch/links";
import { documentStudioInputs, featuresForEngine } from "../kernel/buildInput";
import type { Feature, JuraCADDocument } from "../model/types";
import { emptyDocument } from "../model/document";
import { resolveVariables } from "../model/variables";
import { getCurrentScope, setCurrentScope } from "../model/expr";
import { GeometryEngine, type StudiosResult } from "../kernel/engine";
import type { FollowedFrame, PartMesh, RebuildResult } from "../kernel/protocol";
import { InputError } from "./args";
import type { DesignFolder } from "./files";
import type { ToolResult } from "./tools";
import { inStudio } from "../model/studios";

/** What the live link with the user's JuraCAD tab says about itself (see live.ts). */
export interface LiveStatus {
  connected: boolean;
  /** Plain-English summary for Claude (what's open, or how to connect). */
  text: string;
}

/**
 * The live link with a JuraCAD tab (src/mcp/live.ts). While it's connected,
 * every tool works on the design open in that tab, and changes are sent back.
 */
export interface LiveLink {
  /** `signal`: aborted when Claude cancels the call (the change is then not sent, if it hasn't been yet). */
  call(s: Session, tool: string, run: () => Promise<ToolResult>, signal?: AbortSignal): Promise<ToolResult>;
  status(): LiveStatus;
}

/** Everything a tool can change, to put back if the open JuraCAD tab doesn't take a change. */
export interface SessionSnapshot {
  doc: JuraCADDocument;
  past: JuraCADDocument[];
  file: string | null;
  saved: JuraCADDocument | null;
  generation: number;
  outer: Session["outer"];
}

export interface Build {
  parts: PartMesh[];
  errors: Record<string, string>;
  /** Features built, but with something to tell (not failures). */
  warnings: Record<string, string>;
  /** Plain information about features built (what Simplify did). */
  notes?: Record<string, string>;
  /** Sketches on part faces or using part edges: where the engine moved them to (see RebuildResult.sketchLinks). */
  links?: Record<string, SketchLinkInfo>;
  /** Planes that follow the model and mate connectors, where they are as built (see RebuildResult.followed). */
  followed?: Record<string, FollowedFrame>;
  /** Curve features (Helix, Fit spline…) as lines (see RebuildResult.curves). */
  curves?: Record<string, number[][]>;
  /** Frames' path pieces from part edges and curves (see RebuildResult.framePaths). */
  framePaths?: RebuildResult["framePaths"];
}

/**
 * Thrown at a checkpoint when Claude has cancelled the call (MCP's
 * notifications/cancelled): the tool stops there and callTool puts the design
 * back as it was.
 */
export class Cancelled extends Error {
  constructor() {
    super("The call was cancelled.");
  }
}

/** Let waiting messages (such as a cancellation from Claude) arrive: two turns of Node's event loop. */
export function yieldToEvents(): Promise<void> {
  const hop = () => new Promise<void>((resolve) => (typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0)));
  return hop().then(hop);
}

const MAX_UNDO = 100;

/** How long the second engine (assemblies and drawings) may sit unused before its shapes are freed (built again when next needed). */
export const WHOLE_ENGINE_IDLE_MS = 10 * 60_000;

export class Session {
  doc: JuraCADDocument = emptyDocument("Untitled part");
  /** Earlier versions, newest last (for undo). */
  past: JuraCADDocument[] = [];
  /** The file this design was last opened from or saved to. */
  file: string | null = null;
  /** The document as it was when last saved or opened (to tell if there are unsaved changes). */
  saved: JuraCADDocument | null = null;
  /** Goes up each time the design is replaced as a whole (new_design, open_design). */
  generation = 0;
  /**
   * When the design came from the user's open JuraCAD tab: the whole document
   * and the Part Studio being worked on. `doc` is then that studio's view (its
   * features in `features`), which is what the tools work on.
   */
  outer: { doc: JuraCADDocument; studio: string } | null = null;
  /** The live link with a JuraCAD tab, when the extension has one (it may not be connected). */
  live: LiveLink | null = null;
  /** Calls run one at a time (Claude may send several at once; tools wait at checkpoints, so they'd otherwise interleave). */
  private queue: Promise<unknown> = Promise.resolve();
  /** Set while a call runs: aborted when Claude cancels it. */
  signal: AbortSignal | null = null;
  /** Set when the call running now has written a file (which can't be taken back if it's cancelled after). */
  wroteFile = false;
  private engine: GeometryEngine;
  private builtKey = "";
  private built: Build | null = null;
  /** A second engine for the whole document (every Part Studio), for assemblies and drawings; made when first needed. */
  private wholeEngine: GeometryEngine | null = null;
  private wholeKey = "";
  private wholeBuilt: Build | null = null;
  /** The meshes of each Part Studio as last built by the whole-document engine (it only sends those it rebuilt). */
  private wholeMeshes = new Map<string, PartMesh[]>();
  /** Calls running now (the second engine is only freed between calls). */
  private running = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many times the second engine has been freed for being idle (for tests and logs). */
  wholeReleases = 0;

  constructor(
    readonly folder: DesignFolder | null,
    private readonly makeEngine: () => GeometryEngine = () => new GeometryEngine(),
    /** Free the second engine after it's been unused this long (ms); 0 = never. */
    readonly wholeIdleMs = WHOLE_ENGINE_IDLE_MS,
  ) {
    this.engine = makeEngine();
  }

  /** Run calls one after another, in the order they came. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      this.running++;
      try {
        return await fn();
      } finally {
        this.running--;
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /** Has Claude cancelled the call running now? */
  get cancelled(): boolean {
    return !!this.signal?.aborted;
  }

  /** Stop here if the call has been cancelled. */
  throwIfCancelled(): void {
    if (this.cancelled) throw new Cancelled();
  }

  /**
   * Between slow steps: let a cancellation from Claude arrive, and stop if it
   * has. (Building is done in one go, so a call stops at the next of these.)
   */
  async checkpoint(): Promise<void> {
    this.throwIfCancelled();
    if (!this.signal) return;
    await yieldToEvents();
    this.throwIfCancelled();
  }

  /** The values of the design's variables, by name. */
  scope(doc = this.doc): Record<string, number> {
    return resolveVariables(doc.variables).values;
  }

  /** Build these features (by default the whole design) with the real geometry engine. */
  build(features: Feature[] = this.doc.features, doc = this.doc): Build {
    const scope = this.scope(doc);
    // Folders, sketch pictures and the eye don't change shapes: leave them out, so clicking them doesn't rebuild.
    const key = JSON.stringify([featuresForEngine(features), scope, doc.partNames ?? {}]);
    if (this.built && key === this.builtKey) return this.built;
    setCurrentScope(scope);
    return this.keepBuild(key, this.engine.rebuild(features, scope, doc.partNames ?? {}));
  }

  /**
   * As build, but a call Claude cancels stops between features (rather than
   * after the whole build): the build is then forgotten and Cancelled thrown.
   */
  async buildAsync(features: Feature[] = this.doc.features, doc = this.doc): Promise<Build> {
    if (!this.signal) return this.build(features, doc);
    const scope = this.scope(doc);
    const key = JSON.stringify([featuresForEngine(features), scope, doc.partNames ?? {}]);
    if (this.built && key === this.builtKey) return this.built;
    setCurrentScope(scope);
    let r: StudiosResult;
    try {
      r = await this.engine.rebuildAsync(features, scope, doc.partNames ?? {}, () => this.pause());
    } catch (e) {
      // The engine no longer holds what was built last.
      this.built = null;
      this.builtKey = "";
      throw e;
    } finally {
      setCurrentScope(this.scope());
    }
    return this.keepBuild(key, r);
  }

  private keepBuild(key: string, r: RebuildResult): Build {
    this.built = { parts: r.parts.filter((p) => !p.configuration), errors: r.featureErrors, warnings: r.featureWarnings ?? {}, notes: r.featureNotes ?? {}, links: r.sketchLinks ?? {}, ...(r.followed ? { followed: r.followed } : {}), ...(r.curves ? { curves: r.curves } : {}), ...(r.framePaths ? { framePaths: r.framePaths } : {}) };
    this.builtKey = key;
    return this.built;
  }

  /** Between two features of a build: let a cancellation arrive (with the design's own values in place meanwhile). */
  private async pause(): Promise<void> {
    const building = getCurrentScope();
    setCurrentScope(this.scope());
    try {
      await this.checkpoint();
    } finally {
      setCurrentScope(building);
    }
  }

  /** Use the engine on the design as it is now (building it first if needed). */
  withEngine<T>(fn: (engine: GeometryEngine) => T): T {
    this.build();
    return fn(this.engine);
  }

  /**
   * Build the whole document — every Part Studio, and Part Studios shown in
   * other configurations by assemblies — for assemblies and drawings. Parts
   * made in other configurations have `configuration` set.
   */
  buildAll(doc = this.wholeDoc()): Build {
    const scope = this.scope(doc);
    const studios = documentStudioInputs(doc);
    const key = JSON.stringify([studios, scope, doc.partNames ?? {}]);
    this.touchWhole();
    if (this.wholeBuilt && key === this.wholeKey) return this.wholeBuilt;
    setCurrentScope(scope);
    this.wholeEngine ??= this.makeEngine();
    let r: StudiosResult;
    try {
      r = this.wholeEngine.rebuildStudios(studios, scope, doc.partNames ?? {});
    } finally {
      // Back to the design's own values, even if the build failed.
      setCurrentScope(this.scope());
    }
    return this.keepWhole(key, r);
  }

  /** As buildAll, but a call Claude cancels stops between features (see buildAsync). */
  async buildAllAsync(doc = this.wholeDoc()): Promise<Build> {
    if (!this.signal) return this.buildAll(doc);
    const scope = this.scope(doc);
    const studios = documentStudioInputs(doc);
    const key = JSON.stringify([studios, scope, doc.partNames ?? {}]);
    this.touchWhole();
    if (this.wholeBuilt && key === this.wholeKey) return this.wholeBuilt;
    setCurrentScope(scope);
    this.wholeEngine ??= this.makeEngine();
    let r: StudiosResult;
    try {
      r = await this.wholeEngine.rebuildStudiosAsync(studios, scope, doc.partNames ?? {}, () => this.pause());
    } catch (e) {
      // The Part Studios it rebuilt before stopping are built again next time; the others' meshes still hold.
      this.wholeBuilt = null;
      this.wholeKey = "";
      throw e;
    } finally {
      setCurrentScope(this.scope());
    }
    return this.keepWhole(key, r);
  }

  private keepWhole(key: string, r: StudiosResult): Build {
    const rebuilt = new Map<string, PartMesh[]>(r.rebuilt.map((id) => [id, []]));
    for (const p of r.parts) rebuilt.get(p.studioId ?? "")?.push(p);
    for (const [id, list] of rebuilt) this.wholeMeshes.set(id, list);
    for (const id of [...this.wholeMeshes.keys()]) if (!r.studioOrder.includes(id)) this.wholeMeshes.delete(id);
    this.wholeBuilt = { parts: r.studioOrder.flatMap((id) => this.wholeMeshes.get(id) ?? []), errors: r.featureErrors, warnings: r.featureWarnings ?? {} };
    this.wholeKey = key;
    return this.wholeBuilt;
  }

  /** Use the whole-document engine (building everything first if needed). */
  withWholeEngine<T>(fn: (engine: GeometryEngine, build: Build) => T): T {
    const b = this.buildAll();
    return fn(this.wholeEngine!, b);
  }

  /**
   * Free the second engine's shapes (everything it built for assemblies and
   * drawings); it's made again, and everything built again, when next needed.
   * Its memory goes back to the geometry engine's own store, for the first
   * engine to reuse (the process itself doesn't shrink: WebAssembly memory
   * never does), so a session that's done with assemblies stops holding a
   * second copy of every part.
   */
  releaseWholeEngine(): boolean {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.wholeEngine) return false;
    this.wholeEngine.dispose();
    this.wholeEngine = null;
    this.wholeBuilt = null;
    this.wholeKey = "";
    this.wholeMeshes.clear();
    return true;
  }

  /** The second engine was just used: free it once it's been left alone for `wholeIdleMs` (never during a call). */
  private touchWhole(): void {
    if (!this.wholeIdleMs) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const check = () => {
      if (this.running > 0) {
        this.idleTimer = setTimeout(check, Math.min(this.wholeIdleMs, 60_000));
        (this.idleTimer as { unref?: () => void }).unref?.();
        return;
      }
      if (this.releaseWholeEngine()) this.wholeReleases++;
    };
    this.idleTimer = setTimeout(check, this.wholeIdleMs);
    // (A waiting timer doesn't keep the extension running.)
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  /** Use the engine as it was last built (whatever was built last), without building anything. */
  engineAsBuilt<T>(fn: (engine: GeometryEngine) => T): T {
    return fn(this.engine);
  }

  /** Make `next` the design, keeping the old one for undo. */
  commit(next: JuraCADDocument): void {
    this.past.push(this.doc);
    if (this.past.length > MAX_UNDO) this.past.shift();
    this.doc = next;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.doc = prev;
    return true;
  }

  /** Start again with a new design (or one just opened). */
  reset(doc: JuraCADDocument, file: string | null): void {
    this.doc = doc;
    this.past = [];
    this.file = file;
    this.saved = file ? doc : null;
    this.outer = null;
    this.generation++;
  }

  /** The whole document: with the other Part Studios when this is a studio of the open JuraCAD tab. */
  wholeDoc(): JuraCADDocument {
    return this.outer ? inStudio(this.outer.doc, this.outer.studio, () => this.doc) : this.doc;
  }

  /**
   * Work on the design open in the user's JuraCAD tab (one Part Studio of it).
   * Claude's own undo steps are dropped: the user may have changed anything.
   */
  adopt(view: JuraCADDocument, outer: { doc: JuraCADDocument; studio: string }): void {
    this.doc = view;
    this.past = [];
    this.outer = outer;
  }

  snapshot(): SessionSnapshot {
    return { doc: this.doc, past: [...this.past], file: this.file, saved: this.saved, generation: this.generation, outer: this.outer };
  }

  restore(snap: SessionSnapshot): void {
    this.doc = snap.doc;
    this.past = [...snap.past];
    this.file = snap.file;
    this.saved = snap.saved;
    this.generation = snap.generation;
    this.outer = snap.outer;
  }

  get unsaved(): boolean {
    return this.saved !== this.doc && (this.doc.features.length > 0 || this.saved !== null);
  }

  /** A feature by its id or name (any capitals), optionally only of some types. */
  feature(ref: unknown, where: string, types?: readonly string[], doc = this.doc): Feature {
    if (typeof ref !== "string" || !ref.trim()) throw new InputError(`${where}: give a feature's id or name, e.g. "Sketch 1".`);
    const want = ref.trim().toLowerCase();
    const f = doc.features.find((x) => x.id.toLowerCase() === want) ?? doc.features.find((x) => x.name.toLowerCase() === want);
    const choices = doc.features.filter((x) => !types || types.includes(x.type)).map((x) => `${x.name} (${x.id})`);
    if (!f) throw new InputError(`${where}: there's no feature "${ref}". ${choices.length ? `The ${types ? "ones that fit" : "features"} are: ${choices.join(", ")}.` : "The design has no features yet."}`);
    if (types && !types.includes(f.type)) {
      throw new InputError(`${where}: ${f.name} is a ${f.type}, not a ${types.join(" or ")}.${choices.length ? ` Choose one of: ${choices.join(", ")}.` : ""}`);
    }
    return f;
  }

  /** A part by name or id (any capitals); with no name, the part made most recently. */
  part(parts: PartMesh[], ref: unknown, where: string): PartMesh {
    if (!parts.length) throw new InputError(`${where}: there are no parts yet. Make one first (add_sketch then add_feature with "extrude", or a "box").`);
    if (ref === undefined || ref === null || ref === "") return parts[parts.length - 1];
    if (typeof ref !== "string") throw new InputError(`${where}: give a part's name, e.g. "Part 1".`);
    const want = ref.trim().toLowerCase();
    const p = parts.find((x) => x.id.toLowerCase() === want) ?? parts.find((x) => x.name.toLowerCase() === want);
    if (!p) throw new InputError(`${where}: there's no part "${ref}". The parts are: ${parts.map((x) => x.name).join(", ")}.`);
    return p;
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.engine.dispose();
    this.wholeEngine?.dispose();
    this.wholeEngine = null;
  }
}
