/**
 * The design Claude is working on: the document (exactly what a .juracad file
 * holds), its undo history, and the geometry engine that builds it.
 */
import type { Feature, JuraCADDocument } from "../model/types";
import { emptyDocument } from "../model/document";
import { resolveVariables } from "../model/variables";
import { setCurrentScope } from "../model/expr";
import { GeometryEngine } from "../kernel/engine";
import type { PartMesh } from "../kernel/protocol";
import { InputError } from "./args";
import type { DesignFolder } from "./files";

export interface Build {
  parts: PartMesh[];
  errors: Record<string, string>;
}

const MAX_UNDO = 100;

export class Session {
  doc: JuraCADDocument = emptyDocument("Untitled part");
  /** Earlier versions, newest last (for undo). */
  past: JuraCADDocument[] = [];
  /** The file this design was last opened from or saved to. */
  file: string | null = null;
  /** The document as it was when last saved or opened (to tell if there are unsaved changes). */
  saved: JuraCADDocument | null = null;
  private engine: GeometryEngine;
  private builtKey = "";
  private built: Build | null = null;

  constructor(
    readonly folder: DesignFolder | null,
    makeEngine: () => GeometryEngine = () => new GeometryEngine(),
  ) {
    this.engine = makeEngine();
  }

  /** The values of the design's variables, by name. */
  scope(doc = this.doc): Record<string, number> {
    return resolveVariables(doc.variables).values;
  }

  /** Build these features (by default the whole design) with the real geometry engine. */
  build(features: Feature[] = this.doc.features, doc = this.doc): Build {
    const scope = this.scope(doc);
    const key = JSON.stringify([features, scope, doc.partNames ?? {}]);
    if (this.built && key === this.builtKey) return this.built;
    setCurrentScope(scope);
    const r = this.engine.rebuild(features, scope, doc.partNames ?? {});
    this.built = { parts: r.parts.filter((p) => !p.configuration), errors: r.featureErrors };
    this.builtKey = key;
    return this.built;
  }

  /** Use the engine on the design as it is now (building it first if needed). */
  withEngine<T>(fn: (engine: GeometryEngine) => T): T {
    this.build();
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
    this.engine.dispose();
  }
}
