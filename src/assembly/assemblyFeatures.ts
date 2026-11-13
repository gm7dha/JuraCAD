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
import type { AssemblyCutsResult } from "../kernel/protocol";
import type { SketchData } from "../sketch/types";
import type { SketchPlane } from "../sketch/planes";
import { updateAssembly } from "./assembly";
import { PATH_SEP } from "./subassembly";
import { isAssemblyEdgeFeature, isAssemblyFeature } from "./featureParse";
import type { EdgeRef, TopoPick, TopoRef, Vec3 } from "../geometry/topoRef";
import { applyPlacement, invert, rotate, type Placement } from "./math";
import type { PartMesh } from "../kernel/protocol";

export { ASSEMBLY_CUT_TYPES, ASSEMBLY_FEATURE_TYPES, isAssemblyEdgeFeature, isAssemblyFeature, parseFeatureParts } from "./featureParse";

const NO_FEATURES: Feature[] = [];

/** An assembly's features, in order (none for older files). */
export const assemblyFeaturesOf = (a: Pick<Assembly, "features">): Feature[] => a.features ?? NO_FEATURES;

/** The sketch a cutting feature uses. */
export const sketchOfCut = (f: Feature): string | undefined => (f.type === "hole" ? f.hole?.sketchRef : f.sketchRef);

/** True when a feature with no chosen parts would cut `key` (top-level plain parts only). */
const cutsByDefault = (key: string) => !key.includes(PATH_SEP);

/** Whether assembly feature `f` cuts the part with key `key` (a Fillet / Chamfer: has edges picked on it). */
export function featureCuts(a: Pick<Assembly, "featureParts">, f: Feature, key: string): boolean {
  if (f.suppressed || f.type === "sketch") return false;
  if (isAssemblyEdgeFeature(f)) return (f.picks ?? []).some((p) => p.partId === key);
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
  return list
    .filter((f) => tools.includes(f) || (f.type === "sketch" && !f.suppressed && sketches.has(f.id)))
    .map((f) => (isAssemblyEdgeFeature(f) ? onlyPicksOn(f, key) : f));
}

/** A Fillet / Chamfer with only its edges on copy `key` (the same object when they all are). */
const ownPicks = new WeakMap<Feature, Map<string, Feature>>();
function onlyPicksOn(f: Feature, key: string): Feature {
  const picks = f.picks ?? [];
  if (picks.every((p) => p.partId === key)) return f;
  let byKey = ownPicks.get(f);
  if (!byKey) ownPicks.set(f, (byKey = new Map()));
  let out = byKey.get(key);
  if (!out) byKey.set(key, (out = { ...f, picks: picks.filter((p) => p.partId === key) }));
  return out;
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
  const list = assemblyFeaturesOf(a);
  const going = new Set(findDependents(list, ids).going);
  // A Fillet / Chamfer of edges only a cut made (a drilled hole's rim) goes with that cut, and what uses it with it.
  for (;;) {
    const more = list.filter((f) => !going.has(f.id) && (a.featureNeeds?.[f.id] ?? []).some((id) => going.has(id))).map((f) => f.id);
    if (!more.length) break;
    for (const id of findDependents(list, [...going, ...more]).going) going.add(id);
  }
  return list.filter((f) => going.has(f.id)).map((f) => f.id);
}

/** Delete assembly features, and the ones using them (cuts of a deleted sketch). */
export function deleteAssemblyFeatures(a: Assembly, ids: string[]): Assembly {
  const going = new Set(assemblyFeatureDependents(a, ids));
  const features = assemblyFeaturesOf(a).filter((f) => !going.has(f.id));
  const parts = Object.fromEntries(Object.entries(a.featureParts ?? {}).filter(([id]) => !going.has(id)));
  const needs = Object.fromEntries(Object.entries(a.featureNeeds ?? {}).filter(([id]) => !going.has(id)));
  const { features: _f, featureParts: _p, featureNeeds: _n, ...plain } = a;
  return {
    ...plain,
    ...(features.length ? { features } : {}),
    ...(Object.keys(parts).length ? { featureParts: parts } : {}),
    ...(Object.keys(needs).length ? { featureNeeds: needs } : {}),
  };
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

export interface EdgeSpec {
  /** The fillet's radius, or the chamfer's distance (mm). */
  size: number;
}

/**
 * A Fillet or Chamfer in an assembly: edges picked on copies (each pick's `partId` = the copy's key, its `ref` in the
 * part's own coordinates, on the copy as the assembly's earlier features left it), rounded on this assembly's copies
 * only. The edges go with their copy when a mate moves it.
 */
export function assemblyEdgeFeature(a: Pick<Assembly, "features">, kind: "fillet" | "chamfer", picks: TopoPick[], spec: EdgeSpec, id = newId("af")): Feature {
  const size = `${spec.size} mm`;
  return {
    id,
    name: nextFeatureName(a, kind === "fillet" ? "Fillet" : "Chamfer"),
    type: kind,
    operation: "new",
    suppressed: false,
    params: { ...defaultParams(kind), ...(kind === "fillet" ? { radius: size } : { distance: size }) },
    picks,
  };
}

const near = (p: readonly number[], q: readonly number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-3;
const sub3 = (p: readonly number[], q: readonly number[]): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot3 = (p: readonly number[], q: readonly number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];

/** Whether `e` lies on the same straight line as `ref` and overlaps it (a piece of the same edge, made shorter or longer). */
function sameLine(e: EdgeRef, ref: EdgeRef): boolean {
  const d = sub3(ref.b, ref.a);
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-9) return false;
  const u: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
  const off = (p: readonly number[]) => {
    const w = sub3(p, ref.a);
    const t = dot3(w, u);
    return { t, gap: Math.hypot(w[0] - t * u[0], w[1] - t * u[1], w[2] - t * u[2]) };
  };
  const ea = off(e.a);
  const eb = off(e.b);
  if (ea.gap > 1e-3 || eb.gap > 1e-3) return false;
  return Math.min(Math.max(ea.t, eb.t), len) - Math.max(Math.min(ea.t, eb.t), 0) > 1e-6;
}

/**
 * Whether a part (or a cut copy) has an edge or face where `ref` is: the same edge, or for a straight edge any piece of
 * the same line overlapping it (a notch that shortens an edge doesn't make it a new one); a face of the same kind on the
 * same plane, or at the same place.
 */
export function hasRef(mesh: Pick<PartMesh, "edgeRefs" | "faceRefs">, ref: TopoRef): boolean {
  if (ref.kind === "edge") {
    return mesh.edgeRefs.some(
      (e) => e.curve === ref.curve && ((e.curve === "LINE" && sameLine(e, ref)) || (near(e.mid, ref.mid) && ((near(e.a, ref.a) && near(e.b, ref.b)) || (near(e.a, ref.b) && near(e.b, ref.a))))),
    );
  }
  return mesh.faceRefs.some((f) => {
    if (f.surface !== ref.surface || dot3(f.normal, ref.normal) < 1 - 1e-6) return false;
    return f.surface === "PLANE" ? Math.abs(dot3(sub3(f.center, ref.center), ref.normal)) < 1e-3 : near(f.center, ref.center);
  });
}

const flipX = (v: readonly number[]): Vec3 => [-v[0], v[1], v[2]];

/** A ref in a part's own coordinates, as it is in an assembly level where the copy sits at `at` (mirrored or not). */
export function toLevelRef(ref: TopoRef, at: Placement, mirrored: boolean): TopoRef {
  const point = (p: Vec3) => applyPlacement(at, mirrored ? flipX(p) : p);
  if (ref.kind === "edge") return { kind: "edge", curve: ref.curve, a: point(ref.a), b: point(ref.b), mid: point(ref.mid) };
  return { kind: "face", surface: ref.surface, center: point(ref.center), normal: rotate(at.rotation, mirrored ? flipX(ref.normal) : ref.normal) };
}

/** The other way: a ref in the level's coordinates, in the part's own coordinates for a copy at `at`. */
export function toPartRef(ref: TopoRef, at: Placement, mirrored: boolean): TopoRef {
  const back = invert(at);
  const point = (p: Vec3) => {
    const q = applyPlacement(back, p);
    return mirrored ? flipX(q) : q;
  };
  if (ref.kind === "edge") return { kind: "edge", curve: ref.curve, a: point(ref.a), b: point(ref.b), mid: point(ref.mid) };
  const n = rotate(back.rotation, ref.normal);
  return { kind: "face", surface: ref.surface, center: point(ref.center), normal: mirrored ? flipX(n) : n };
}

/**
 * How a new Fillet / Chamfer keeps its picks (made on the copies as shown, refs in each part's own coordinates): an
 * edge the plain part has (`hasRef`) stays on the part, so it goes with the copy; one only the assembly's own cuts made
 * (a drilled hole's rim) is kept in the assembly's coordinates (`placed`), as the cut is — so when the copy moves it's
 * still that hole's rim, never the nearest other one. `placeOf` = where each copy sits now (and its hand).
 */
export function storedEdgePicks(picks: readonly TopoPick[], plainOf: (key: string) => PartMesh | undefined, placeOf: (key: string) => { at: Placement; mirrored: boolean } | undefined): TopoPick[] {
  return picks.map((p) => {
    const plain = plainOf(p.partId);
    const where = placeOf(p.partId);
    if (!where || (plain && hasRef(plain, p.ref))) return { partId: p.partId, ref: p.ref };
    return { partId: p.partId, ref: toLevelRef(p.ref, where.at, where.mirrored), placed: true };
  });
}

/**
 * The features of a cut stage with their placed picks (see storedEdgePicks) turned into the part's own coordinates for a
 * copy at `at` — worked out again each build, from where the copy is now.
 */
export function stageFeatures(features: Feature[], at: Placement, mirrored: boolean): Feature[] {
  if (!features.some((f) => isAssemblyEdgeFeature(f) && f.picks?.some((p) => p.placed))) return features;
  return features.map((f) =>
    isAssemblyEdgeFeature(f) && f.picks?.some((p) => p.placed) ? { ...f, picks: f.picks.map((p) => (p.placed ? { partId: p.partId, ref: toPartRef(p.ref, at, mirrored) } : p)) } : f,
  );
}

/**
 * Which of the assembly's features a new Fillet / Chamfer needs (`Assembly.featureNeeds`): for each picked edge (refs in
 * the parts' own coordinates, as picked) the plain part hasn't got (`hasRef`), the features that changed that copy
 * (`reached`) without which the edge isn't there — `without(id, key)` is the copy made with that one left out (undefined
 * = nothing else changes it: the plain part). If no single one made it (several together), all of them.
 */
export function edgeNeeds(
  picks: readonly TopoPick[],
  plainOf: (key: string) => PartMesh | undefined,
  reached: Readonly<Record<string, readonly string[]>>,
  without: (id: string, key: string) => PartMesh | undefined,
): string[] {
  const out = new Set<string>();
  for (const p of picks) {
    const plain = plainOf(p.partId);
    if (!plain || hasRef(plain, p.ref)) continue;
    const by = Object.entries(reached).filter(([, keys]) => keys.includes(p.partId)).map(([id]) => id);
    const makers = by.filter((id) => !hasRef(without(id, p.partId) ?? plain, p.ref));
    for (const id of makers.length ? makers : by) out.add(id);
  }
  return [...out];
}

/** Keep what a new Fillet / Chamfer needs (see edgeNeeds). */
export function setFeatureNeeds(a: Assembly, id: string, needs: readonly string[]): Assembly {
  if (!needs.length) return a;
  return { ...a, featureNeeds: { ...(a.featureNeeds ?? {}), [id]: [...new Set(needs)] } };
}

/** One line per assembly feature, for describe_assembly. */
export function assemblyFeaturesText(asm: Assembly, nameOf: (key: string) => string, errors: Record<string, string> = {}): string | null {
  const list = assemblyFeaturesOf(asm);
  if (!list.length) return null;
  const lines = list.map((f) => {
    if (f.type === "sketch") return `- ${f.name} (a sketch)${f.suppressed ? " — suppressed" : ""}`;
    if (isAssemblyEdgeFeature(f)) {
      const picks = f.picks ?? [];
      const on = [...new Set(picks.map((p) => p.partId))].map(nameOf);
      const size = f.type === "fillet" ? `radius ${f.params.radius}` : `distance ${f.params.distance}`;
      const what = picks.length ? `${picks.length} edge${picks.length === 1 ? "" : "s"} of ${on.join(", ")}` : "no edges left (their parts were removed)";
      return `- ${f.name} (${f.type}, ${size}, on ${what})${f.suppressed ? " — suppressed" : ""}${errors[f.id] ? ` — PROBLEM: ${errors[f.id]}` : ""}`;
    }
    const chosen = asm.featureParts?.[f.id];
    const whom = chosen ? (chosen.length ? `cuts only ${chosen.map(nameOf).join(", ")}` : "cuts nothing (no parts chosen)") : "cuts every part it reaches";
    const sketch = list.find((x) => x.id === sketchOfCut(f))?.name ?? "its sketch";
    return `- ${f.name} (${f.type === "hole" ? "hole" : `${f.type}, removing`}, from ${sketch}; ${whom})${f.suppressed ? " — suppressed" : ""}${errors[f.id] ? ` — PROBLEM: ${errors[f.id]}` : ""}`;
  });
  return `Assembly features (made only in this assembly; the parts themselves are unchanged):\n${lines.join("\n")}`;
}

/** The copies the engine found cut (AssemblyCutsResult), with what's left of each (mm³), for the parts list. */
export function modifiedCopies(result: Pick<AssemblyCutsResult, "cut" | "meshes">): Map<string, number | undefined> {
  return new Map(result.cut.map((k) => [k, result.meshes.find((m) => m.id === k)?.volume]));
}
