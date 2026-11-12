/**
 * Assembly features (as in Onshape): sketches drawn in an assembly, and cuts
 * made there — an Extrude or Revolve that removes, or a Hole — through the
 * chosen parts of that assembly only. The parts in their Part Studios don't
 * change; only the copies in this assembly are cut (what the 3D view, exports,
 * drawings, the clash check and the parts list of this assembly use).
 *
 * The cuts are in the assembly's own coordinates, where they were made: a
 * hole drilled through two plates stays where it was drawn, and a part that a
 * mate moves is cut where it now sits. The engine (placeInstances) cuts each
 * copy as it is placed: `InstanceInput.cuts` (the sketches and cutting
 * features that reach it, from `cutsFor`).
 *
 * Which parts a feature cuts: `Assembly.featureParts[id]` (part keys); missing
 * = every top-level part it reaches. Parts inside sub-assemblies are cut only
 * when chosen (their keys are "copy/inner/part").
 *
 * Pure: no store, no engine.
 */
import { newId } from "../model/document";
import { findDependents } from "../model/dependents";
import { defaultParams } from "../model/features";
import type { Assembly, Feature, JuraCADDocument } from "../model/types";
import type { SketchData } from "../sketch/types";
import type { SketchPlane } from "../sketch/planes";
import { updateAssembly } from "./assembly";
import { PATH_SEP } from "./subassembly";
import { isAssemblyFeature } from "./featureParse";

export { ASSEMBLY_CUT_TYPES, ASSEMBLY_FEATURE_TYPES, isAssemblyFeature, parseFeatureParts } from "./featureParse";

const NO_FEATURES: Feature[] = [];

/** An assembly's features, in order (none for older files). */
export const assemblyFeaturesOf = (a: Pick<Assembly, "features">): Feature[] => a.features ?? NO_FEATURES;

/** The sketch a cutting feature uses. */
export const sketchOfCut = (f: Feature): string | undefined => (f.type === "hole" ? f.hole?.sketchRef : f.sketchRef);

/** True when a feature with no chosen parts would cut `key` (top-level plain parts only). */
const cutsByDefault = (key: string) => !key.includes(PATH_SEP);

/** Whether assembly feature `f` cuts the part with key `key`. */
export function featureCuts(a: Pick<Assembly, "featureParts">, f: Feature, key: string): boolean {
  if (f.suppressed || f.type === "sketch") return false;
  const chosen = a.featureParts?.[f.id];
  return chosen ? chosen.includes(key) : cutsByDefault(key);
}

/**
 * The assembly features that reach the part with key `key`, as the engine
 * wants them: the cutting features in order, each with the sketch it uses (sketches
 * first, where they are in the list). Undefined when nothing cuts it, so parts with
 * no cuts are given to the engine exactly as before.
 */
export function cutsFor(a: Pick<Assembly, "features" | "featureParts">, key: string): Feature[] | undefined {
  const list = assemblyFeaturesOf(a);
  if (!list.length) return undefined;
  const tools = list.filter((f) => isAssemblyFeature(f) && featureCuts(a, f, key));
  if (!tools.length) return undefined;
  const sketches = new Set(tools.map(sketchOfCut).filter((x): x is string => !!x));
  return list.filter((f) => tools.includes(f) || (f.type === "sketch" && !f.suppressed && sketches.has(f.id)));
}

/** The keys an assembly's features may cut (those with any cut reaching them), among `keys`. */
export function keysWithCuts(a: Pick<Assembly, "features" | "featureParts">, keys: readonly string[]): string[] {
  return keys.filter((k) => cutsFor(a, k) !== undefined);
}

/** A name not yet used by the assembly's features ("Hole 1", "Hole 2"…). */
export function nextFeatureName(a: Pick<Assembly, "features">, base: string): string {
  const names = new Set(assemblyFeaturesOf(a).map((f) => f.name));
  let n = 1;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Add features at the end of an assembly's list (with `parts` = which parts the last one cuts; missing = all it reaches). */
export function addAssemblyFeatures(doc: JuraCADDocument, assemblyId: string, features: Feature[], parts?: Record<string, string[]>): JuraCADDocument {
  return updateAssembly(doc, assemblyId, (a) => ({
    ...a,
    features: [...assemblyFeaturesOf(a), ...features],
    ...(parts && Object.keys(parts).length ? { featureParts: { ...(a.featureParts ?? {}), ...parts } } : {}),
  }));
}

/** Change one of an assembly's features. */
export function changeAssemblyFeature(doc: JuraCADDocument, assemblyId: string, id: string, change: (f: Feature) => Feature): JuraCADDocument {
  return updateAssembly(doc, assemblyId, (a) => ({ ...a, features: assemblyFeaturesOf(a).map((f) => (f.id === id ? change(f) : f)) }));
}

/** Choose the parts a feature cuts (null = every top-level part it reaches). */
export function setFeatureParts(a: Assembly, id: string, keys: string[] | null): Assembly {
  const rest = { ...(a.featureParts ?? {}) };
  if (keys) rest[id] = [...new Set(keys)];
  else delete rest[id];
  const { featureParts: _old, ...plain } = a;
  return Object.keys(rest).length ? { ...plain, featureParts: rest } : plain;
}

/**
 * What deleting assembly features takes with it (a sketch's cuts go with it), as
 * Delete with dependents in a Part Studio: the features picked and those using them.
 */
export function assemblyFeatureDependents(a: Assembly, ids: string[]): string[] {
  return findDependents(assemblyFeaturesOf(a), ids).going;
}

/** Delete assembly features, and the ones using them (cuts of a deleted sketch). */
export function deleteAssemblyFeatures(a: Assembly, ids: string[]): Assembly {
  const going = new Set(assemblyFeatureDependents(a, ids));
  const features = assemblyFeaturesOf(a).filter((f) => !going.has(f.id));
  const parts = Object.fromEntries(Object.entries(a.featureParts ?? {}).filter(([id]) => !going.has(id)));
  const { features: _f, featureParts: _p, ...plain } = a;
  return { ...plain, ...(features.length ? { features } : {}), ...(Object.keys(parts).length ? { featureParts: parts } : {}) };
}

export { tidyFeatureParts } from "./assembly";

// ---------------------------------------------------------------------------
// Making the features (the app's dialogs and Claude's tool)

/** A sketch in the assembly on a plane (in the assembly's coordinates). */
export function assemblySketch(a: Pick<Assembly, "features">, plane: SketchPlane, data: SketchData, id = newId("af")): Feature {
  return { id, name: nextFeatureName(a, "Sketch"), type: "sketch", operation: "new", suppressed: false, params: defaultParams("sketch"), sketch: { plane, data } };
}

export interface HoleSpec {
  diameter: number;
  /** Through every part it meets (else `depth` deep). */
  throughAll: boolean;
  depth?: number;
  /** Drill the other way (out of the face the sketch is on, instead of into it). */
  flip?: boolean;
}

/** A plain hole at a sketch's points (and circle centres), drilled into the face the sketch is on. */
export function assemblyHole(a: Pick<Assembly, "features">, sketchId: string, spec: HoleSpec, id = newId("af")): Feature {
  return {
    id,
    name: nextFeatureName(a, "Hole"),
    type: "hole",
    operation: "remove",
    suppressed: false,
    params: { ...defaultParams("hole"), diameter: `${spec.diameter} mm`, ...(spec.depth !== undefined ? { depth: `${spec.depth} mm` } : {}) },
    hole: { sketchRef: sketchId, kind: "simple", standard: "Custom", fit: "clearance", end: spec.throughAll ? "throughAll" : "blind", flip: !!spec.flip, ...(spec.throughAll ? { bothWays: true } : {}) },
    apart: true,
  };
}

export interface CutSpec {
  throughAll: boolean;
  depth?: number;
  /** Cut out of the face (away from it) instead of into it. */
  flip?: boolean;
}

/** An Extrude that removes, from a sketch's closed shapes, into the face the sketch is on (or through all). */
export function assemblyExtrudeCut(a: Pick<Assembly, "features">, sketchId: string, spec: CutSpec, id = newId("af")): Feature {
  return {
    id,
    name: nextFeatureName(a, "Extrude"),
    type: "extrude",
    operation: "remove",
    suppressed: false,
    sketchRef: sketchId,
    params: { ...defaultParams("extrude"), ...(spec.depth !== undefined ? { depth: `${spec.depth} mm` } : {}) },
    // (Sketches on a face point out of it: into the parts is the other way.)
    extrude: { end: spec.throughAll ? "throughAll" : "blind", flip: !spec.flip },
    apart: true,
  };
}

/** One line per assembly feature, for describe_assembly. */
export function assemblyFeaturesText(asm: Assembly, nameOf: (key: string) => string): string | null {
  const list = assemblyFeaturesOf(asm);
  if (!list.length) return null;
  const lines = list.map((f) => {
    if (f.type === "sketch") return `- ${f.name} (a sketch)${f.suppressed ? " — suppressed" : ""}`;
    const chosen = asm.featureParts?.[f.id];
    const whom = chosen ? (chosen.length ? `cuts only ${chosen.map(nameOf).join(", ")}` : "cuts nothing (no parts chosen)") : "cuts every part it reaches";
    const sketch = list.find((x) => x.id === sketchOfCut(f))?.name ?? "its sketch";
    return `- ${f.name} (${f.type === "hole" ? "hole" : `${f.type}, removing`}, from ${sketch}; ${whom})${f.suppressed ? " — suppressed" : ""}`;
  });
  return `Assembly features (cut only in this assembly; the parts themselves are unchanged):\n${lines.join("\n")}`;
}
