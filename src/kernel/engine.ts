/**
 * The geometry engine: turns the feature list into solid parts using
 * OpenCascade (through replicad). Runs inside the Web Worker, and directly in
 * Node for the automated tests.
 */
import { exportSTEP, getOC, makeBox, measureArea, measureDistanceBetween, measureLength, makeCylinder, makeSphere, measureVolume, type Edge, type Face, type Shape3D, type Vector } from "replicad";

import { analyzeMesh, estimateThickness, withoutDegenerateTriangles } from "../geometry/meshCheck";
import { writeBinaryStl } from "../geometry/stl";
import { matchRefs, relativeTo, roundVec, type EdgeRef, type FaceRef, type TopoPick, type Vec3 } from "../geometry/topoRef";
import { FEATURE_DEFS, isPatternFeature, isPickFeature, isSolidFeature, resolveParams } from "../model/features";
import { planeFrame } from "../sketch/planes";
import { setCurrentScope } from "../model/expr";
import { MESH_TOLERANCES, type Axis, type Feature, type MeshQuality, type Operation } from "../model/types";
import { extrudeSketch } from "./extrude";
import { revolveSketch } from "./revolve";
import { holeTool } from "./hole";
import type { CheckResult, ExportResult, PartMesh, RebuildResult, StepResult, ThreeMfResult } from "./protocol";
import { write3mf } from "../geometry/threeMf";
import { DEFAULT_PART_COLOUR } from "../model/colours";
import { angleBetween, centreGap, circleThrough3D, describePick, type MeasuredItem, type Measurement } from "../geometry/measureMath";

interface BuiltPart {
  id: string;
  name: string;
  featureIds: string[];
  shape: Shape3D;
}

/** Turn whatever OpenCascade threw into a readable sentence. */
export function describeError(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  // OpenCascade C++ exceptions arrive as WebAssembly exceptions; ask the
  // engine for the original message where it can give one.
  try {
    const WasmException = (globalThis as { WebAssembly?: { Exception?: new (...a: never[]) => unknown } })
      .WebAssembly?.Exception;
    if (WasmException && e instanceof WasmException) {
      type WasmEx = Parameters<ReturnType<typeof getOC>["getExceptionMessage"]>[0];
      const [type, message] = getOC().getExceptionMessage(e as WasmEx);
      if (message || type) return `${fallback} (${[type, message].filter(Boolean).join(": ")})`;
    }
  } catch {
    // fall through to the generic message
  }
  return fallback;
}

/** Read a replicad vector into a plain array, freeing the OpenCascade object. */
function take(v: Vector): Vec3 {
  const r: Vec3 = [v.x, v.y, v.z];
  v.delete();
  return r;
}

type Bounds = [Vec3, Vec3];

export function edgeRefOf(e: Edge, bounds: Bounds): EdgeRef {
  const mid = take(e.pointAt(0.5));
  return {
    kind: "edge",
    curve: e.geomType,
    a: roundVec(take(e.startPoint)),
    b: roundVec(take(e.endPoint)),
    mid: roundVec(mid),
    rel: relativeTo(mid, bounds[0], bounds[1]),
  };
}

export function faceRefOf(f: Face, bounds: Bounds): FaceRef {
  const center = take(f.center);
  let normal: Vec3 = [0, 0, 0];
  try {
    normal = take(f.normalAt(center));
  } catch {
    // some surfaces have no normal at their centre of mass; direction is then ignored
  }
  return { kind: "face", surface: f.geomType, center: roundVec(center), normal: roundVec(normal), rel: relativeTo(center, bounds[0], bounds[1]) };
}

function boundsOf(shape: Shape3D): Bounds {
  const box = shape.boundingBox;
  const b = box.bounds as Bounds;
  box.delete();
  return b;
}

/**
 * Find the picked edges (and the edges of picked faces) on a part as it is
 * now. Throws a friendly error if some can't be found.
 */
function findPickedEdges(shape: Shape3D, picks: TopoPick[]): Edge[] {
  const edges = shape.edges;
  const faces = shape.faces;
  const bounds = boundsOf(shape);
  const size = Math.hypot(bounds[1][0] - bounds[0][0], bounds[1][1] - bounds[0][1], bounds[1][2] - bounds[0][2]);
  const edgePicks = picks.filter((p) => p.ref.kind === "edge").map((p) => p.ref);
  const facePicks = picks.filter((p) => p.ref.kind === "face").map((p) => p.ref);
  const edgeMatch = matchRefs(edgePicks, edges.map((e) => edgeRefOf(e, bounds)), size);
  const faceMatch = matchRefs(facePicks, faces.map((f) => faceRefOf(f, bounds)), size);
  const missing = [...edgeMatch, ...faceMatch].filter((m) => m === null).length;
  if (missing > 0) {
    edges.forEach((e) => e.delete());
    faces.forEach((f) => f.delete());
    throw new Error(
      `${missing} of the picked edges or faces can't be found any more (the part has changed too much). Edit this feature and pick them again.`,
    );
  }
  const chosen: Edge[] = edgeMatch.map((i) => edges[i!]);
  for (const i of faceMatch) {
    for (const e of faces[i!].edges) {
      if (chosen.some((c) => c.isSame(e))) e.delete();
      else chosen.push(e);
    }
  }
  edges.forEach((e) => !chosen.includes(e) && e.delete());
  faces.forEach((f) => f.delete());
  return chosen;
}

/** Find the picked faces on a part as it is now. Throws a friendly error if some can't be found. */
function findPickedFaces(shape: Shape3D, picks: TopoPick[]): Face[] {
  const faces = shape.faces;
  const bounds = boundsOf(shape);
  const size = Math.hypot(bounds[1][0] - bounds[0][0], bounds[1][1] - bounds[0][1], bounds[1][2] - bounds[0][2]);
  const match = matchRefs(
    picks.map((p) => p.ref),
    faces.map((f) => faceRefOf(f, bounds)),
    size,
  );
  const missing = match.filter((m) => m === null).length;
  const chosen = match.filter((m): m is number => m !== null).map((i) => faces[i]);
  faces.forEach((f) => !chosen.includes(f) && f.delete());
  if (missing > 0) {
    chosen.forEach((f) => f.delete());
    throw new Error(`${missing} of the picked faces can't be found any more (the part has changed too much). Edit this feature and pick them again.`);
  }
  return chosen;
}

/** True when `after` has less volume than `before` and fits inside its bounding box. */
function shrankWithin(before: Shape3D, after: Shape3D): boolean {
  try {
    const v0 = measureVolume(before);
    const v1 = measureVolume(after);
    if (!(v1 > 1e-6 && v1 < v0 - 1e-6)) return false;
    const [a0, a1] = boundsOf(before);
    const [b0, b1] = boundsOf(after);
    const tol = 1e-3 + 1e-6 * Math.hypot(a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]);
    return [0, 1, 2].every((i) => b0[i] >= a0[i] - tol && b1[i] <= a1[i] + tol);
  } catch {
    return false;
  }
}

/** True when the shape is at least one solid and passes OpenCascade's own check. */
function isValidSolid(shape: Shape3D): boolean {
  try {
    const solids = shape.solids;
    const count = solids.length;
    solids.forEach((x) => x.delete());
    if (count === 0) return false;
    const analyzer = new (getOC().BRepCheck_Analyzer)(shape.wrapped, true, false, false);
    const ok = analyzer.IsValid();
    analyzer.delete();
    return ok;
  } catch {
    return false;
  }
}

/** Sketches seen so far in the rebuild, by feature id. */
type SketchMap = Map<string, Feature>;

/** The furthest any part reaches from a sketch plane's origin. */
function reach(plane: Parameters<typeof planeFrame>[0], parts: BuiltPart[]): number {
  const o = planeFrame(plane).origin;
  let far = 1;
  for (const p of parts) {
    const [lo, hi] = boundsOf(p.shape);
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) far = Math.max(far, Math.hypot(x - o[0], y - o[1], z - o[2]));
  }
  return far;
}

function buildSolid(feature: Feature, v: Record<string, number>, sketches: SketchMap, all: Feature[], parts: BuiltPart[]): Shape3D {
  switch (feature.type) {
    case "extrude":
    case "revolve": {
      const verb = feature.type === "extrude" ? "extrude" : "revolve";
      if (!feature.sketchRef) throw new Error(`Choose a sketch to ${verb}.`);
      const sketch = sketches.get(feature.sketchRef);
      if (!sketch?.sketch?.plane) {
        const exists = all.find((f) => f.id === feature.sketchRef);
        if (!exists) throw new Error("Its sketch has been deleted. Pick another sketch.");
        if (exists.suppressed) throw new Error(`${exists.name} is suppressed, so there's nothing to ${verb}.`);
        if (all.indexOf(exists) > all.indexOf(feature)) throw new Error(`${exists.name} comes after this ${verb} in the list.`);
        throw new Error(`${exists.name} couldn't be used.`);
      }
      if (feature.type === "revolve") {
        const opts = feature.revolve ?? { axis: "vertical", flip: false };
        return revolveSketch(sketch.sketch.plane, sketch.sketch.data, { axis: opts.axis, angle: v.angle, flip: opts.flip });
      }
      const opts = feature.extrude ?? { end: "blind", flip: false };
      if (opts.end === "throughAll") {
        if (feature.operation !== "remove") throw new Error("Through all only works with Remove — it cuts right through the part.");
        // Long enough to pass through every part, both ways from the sketch.
        const depth = 2 * reach(sketch.sketch.plane, parts) + 2;
        return extrudeSketch(sketch.sketch.plane, sketch.sketch.data, { depth, end: "symmetric", flip: false });
      }
      return extrudeSketch(sketch.sketch.plane, sketch.sketch.data, { depth: v.depth, end: opts.end, flip: opts.flip });
    }
    case "hole": {
      const h = feature.hole;
      if (!h?.sketchRef) throw new Error("Choose the sketch whose points mark where the holes go.");
      const sketch = sketches.get(h.sketchRef);
      if (!sketch?.sketch?.plane) {
        const exists = all.find((f) => f.id === h.sketchRef);
        if (!exists) throw new Error("Its sketch has been deleted. Pick another sketch.");
        if (exists.suppressed) throw new Error(`${exists.name} is suppressed, so there's nowhere to drill.`);
        if (all.indexOf(exists) > all.indexOf(feature)) throw new Error(`${exists.name} comes after this hole in the list.`);
        throw new Error(`${exists.name} couldn't be used.`);
      }
      const through = h.end === "throughAll";
      return holeTool(
        sketch.sketch.plane,
        sketch.sketch.data,
        {
          kind: h.kind,
          diameter: v.diameter,
          depth: v.depth,
          throughAll: through,
          throughLength: through ? 2 * reach(sketch.sketch.plane, parts) + 2 : 0,
          cboreDiameter: v.cboreDiameter,
          cboreDepth: v.cboreDepth,
          cskDiameter: v.cskDiameter,
          cskAngle: v.cskAngle,
        },
        h.flip,
      );
    }
    case "transform":
    case "sketch":
    case "fillet":
    case "chamfer":
    case "shell":
    case "mirror":
    case "linearPattern":
    case "circularPattern":
      throw new Error("This feature doesn't make a solid of its own.");
    case "box":
      return makeBox([v.x, v.y, v.z], [v.x + v.width, v.y + v.depth, v.z + v.height]);
    case "cylinder":
      return makeCylinder(v.diameter / 2, v.height, [v.x, v.y, v.z], [0, 0, 1]);
    case "sphere":
      return makeSphere(v.diameter / 2).translate([v.x, v.y, v.z]);
  }
}

/** The solid a feature added or cut, kept so patterns and mirrors can repeat it. */
interface FeatureTool {
  shape: Shape3D;
  operation: Operation;
  /** The part it changed (or made). */
  partId: string;
}

const AXES: Record<Axis, [number, number, number]> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export class GeometryEngine {
  private parts: BuiltPart[] = [];
  private tools = new Map<string, FeatureTool>();

  /** Replays the whole feature list from scratch. */
  rebuild(features: Feature[], variables: Record<string, number> = {}): RebuildResult {
    const started = performance.now();
    // Every size below is worked out with the document's variables.
    setCurrentScope(variables);
    this.disposeParts();
    const featureErrors: Record<string, string> = {};
    let partCounter = 0;
    const sketches: SketchMap = new Map();

    for (const feature of features) {
      if (feature.suppressed) continue;
      if (feature.type === "sketch") {
        // Sketches make no solid themselves; extrudes later in the list use them.
        if (!feature.sketch?.plane) featureErrors[feature.id] = "Pick a plane or flat face to sketch on.";
        else sketches.set(feature.id, feature);
        continue;
      }
      const def = FEATURE_DEFS[feature.type];
      if (!def) {
        featureErrors[feature.id] = "PartSmith doesn't know this kind of feature.";
        continue;
      }
      if (isPickFeature(feature.type)) {
        const err = feature.type === "shell" ? this.applyShell(feature) : this.applyEdgeFeature(feature);
        if (err) featureErrors[feature.id] = err;
        continue;
      }
      if (feature.type === "transform") {
        const r = this.applyTransform(feature, partCounter + 1);
        if (r.error) featureErrors[feature.id] = r.error;
        if (r.newPart) partCounter++;
        continue;
      }
      if (isPatternFeature(feature.type)) {
        const err = this.applyPattern(feature, features);
        if (err) featureErrors[feature.id] = err;
        continue;
      }

      const { values, errors } = resolveParams(feature);
      const badParam = def.params.find((p) => errors[p.key]);
      if (badParam) {
        featureErrors[feature.id] = `${badParam.label}: ${errors[badParam.key]}`;
        continue;
      }

      const target = this.parts[this.parts.length - 1];
      if (feature.operation !== "new" && !target) {
        featureErrors[feature.id] =
          feature.type === "hole"
            ? "There's no part to drill into yet. Make a part first."
            : feature.operation === "add"
            ? "There's no part to add to yet. Use New for the first solid."
            : "There's no part to remove from yet. Use New for the first solid.";
        continue;
      }

      let tool: Shape3D;
      try {
        tool = buildSolid(feature, values, sketches, features, this.parts);
      } catch (e) {
        featureErrors[feature.id] = describeError(e, `Couldn't make this ${def.label.toLowerCase()}.`);
        continue;
      }

      if (feature.operation === "new") {
        partCounter++;
        this.tools.set(feature.id, { shape: tool.clone(), operation: "new", partId: feature.id });
        this.parts.push({ id: feature.id, name: `Part ${partCounter}`, featureIds: [feature.id], shape: tool });
        continue;
      }

      try {
        const result = feature.operation === "add" ? target.shape.fuse(tool) : target.shape.cut(tool);
        if (result.solids.length === 0) {
          result.delete();
          throw new Error("This would remove the whole part.");
        }
        target.shape.delete();
        target.shape = result;
        target.featureIds.push(feature.id);
        this.tools.set(feature.id, { shape: tool.clone(), operation: feature.operation, partId: target.id });
      } catch (e) {
        featureErrors[feature.id] = describeError(
          e,
          feature.operation === "add" ? "Couldn't merge this into the part." : "Couldn't cut this from the part.",
        );
      } finally {
        tool.delete();
      }
    }

    const parts = this.parts.map((p) => this.meshPart(p));
    return { parts, featureErrors, durationMs: Math.round(performance.now() - started) };
  }

  /** Move and/or turn a part, or a copy of it. */
  private applyTransform(feature: Feature, nextPartNumber: number): { error?: string; newPart?: boolean } {
    const def = FEATURE_DEFS.transform;
    const { values, errors } = resolveParams(feature);
    const badParam = def.params.find((p) => errors[p.key]);
    if (badParam) return { error: `${badParam.label}: ${errors[badParam.key]}` };
    const t = feature.transform;
    if (!t?.partId) return { error: "Choose the part to move." };
    const part = this.parts.find((p) => p.id === t.partId);
    if (!part) return { error: "The part it moves no longer exists. Edit this feature and choose another part." };
    if (Math.abs(values.angle) < 1e-12 && Math.abs(values.dx) + Math.abs(values.dy) + Math.abs(values.dz) < 1e-12 && !t.copy) {
      return { error: "Nothing to do yet — enter a distance to move or an angle to turn." };
    }
    let shape = part.shape.clone();
    try {
      if (Math.abs(values.angle) > 1e-12) {
        const [lo, hi] = boundsOf(part.shape);
        const centre: [number, number, number] = t.about === "origin" ? [0, 0, 0] : [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
        shape = shape.rotate(values.angle, centre, AXES[t.axis]);
      }
      if (Math.abs(values.dx) + Math.abs(values.dy) + Math.abs(values.dz) > 0) shape = shape.translate([values.dx, values.dy, values.dz]);
    } catch (e) {
      shape.delete();
      return { error: describeError(e, "Couldn't move this part.") };
    }
    if (t.copy) {
      this.parts.push({ id: feature.id, name: `Part ${nextPartNumber}`, featureIds: [feature.id], shape });
      return { newPart: true };
    }
    part.shape.delete();
    part.shape = shape;
    part.featureIds.push(feature.id);
    return {};
  }

  /**
   * Mirror or pattern: repeat what earlier features did (add or cut their
   * solid) at mirrored, shifted or turned positions. Returns an error message, or null.
   */
  private applyPattern(feature: Feature, all: Feature[]): string | null {
    const def = FEATURE_DEFS[feature.type];
    const { values, errors } = resolveParams(feature);
    const badParam = def.params.find((p) => errors[p.key]);
    if (badParam) return `${badParam.label}: ${errors[badParam.key]}`;
    const mirror = feature.type === "mirror";
    const sourceIds = (mirror ? feature.mirror?.sources : feature.pattern?.sources) ?? [];
    if (sourceIds.length === 0) {
      return `Pick the features to ${mirror ? "mirror" : "repeat"} — click them in the feature list while this dialog is open.`;
    }

    // Use the sources in the order they were built.
    const ordered = all.filter((f) => sourceIds.includes(f.id));
    const at = all.indexOf(feature);
    for (const id of sourceIds) {
      const f = all.find((x) => x.id === id);
      if (!f) return "One of the features it repeats has been deleted. Edit this feature and pick again.";
      if (all.indexOf(f) > at) return `${f.name} comes after this ${def.label.toLowerCase()} in the list.`;
      if (!isSolidFeature(f.type)) return `${f.name} can't be ${mirror ? "mirrored" : "patterned"} — pick features that add or cut a solid.`;
      if (f.suppressed) return `${f.name} is suppressed, so there's nothing to ${mirror ? "mirror" : "repeat"}.`;
      if (!this.tools.has(id)) return `${f.name} couldn't be built, so it can't be ${mirror ? "mirrored" : "repeated"}.`;
    }

    // Where each copy goes.
    const placements: ((s: Shape3D) => Shape3D)[] = [];
    if (mirror) {
      const frame = planeFrame(feature.mirror!.plane);
      placements.push((s) => s.mirror(frame.n, frame.origin));
    } else {
      const axis = AXES[feature.pattern?.axis ?? "x"];
      const sign = feature.pattern?.flip ? -1 : 1;
      const count = values.count;
      if (feature.type === "linearPattern") {
        for (let i = 1; i < count; i++) {
          const d = values.spacing * i * sign;
          placements.push((s) => s.translate([axis[0] * d, axis[1] * d, axis[2] * d]));
        }
      } else {
        if (values.angle > 360) return "Spread over: must be at most 360°";
        const step = values.angle >= 360 - 1e-9 ? 360 / count : values.angle / (count - 1);
        for (let i = 1; i < count; i++) placements.push((s) => s.rotate(step * i * sign, [0, 0, 0], axis));
      }
    }

    // Work on copies of the parts, and only keep them if everything succeeds.
    const working = new Map<string, Shape3D>();
    const release = () => working.forEach((s) => s.delete());
    try {
      for (const source of ordered) {
        const tool = this.tools.get(source.id)!;
        const part = this.parts.find((p) => p.id === tool.partId);
        if (!part) {
          release();
          return `The part ${source.name} belonged to no longer exists.`;
        }
        let shape = working.get(part.id) ?? part.shape.clone();
        for (const place of placements) {
          const copy = place(tool.shape.clone());
          try {
            const next = tool.operation === "remove" ? shape.cut(copy) : shape.fuse(copy);
            shape.delete();
            shape = next;
          } finally {
            copy.delete();
          }
        }
        if (shape.solids.length === 0) {
          shape.delete();
          working.delete(part.id);
          release();
          return "This would remove the whole part.";
        }
        working.set(part.id, shape);
      }
    } catch (e) {
      release();
      return describeError(e, `Couldn't make this ${def.label.toLowerCase()}.`);
    }
    for (const [id, shape] of working) {
      const part = this.parts.find((p) => p.id === id)!;
      part.shape.delete();
      part.shape = shape;
      part.featureIds.push(feature.id);
    }
    return null;
  }

  /** Hollow out a part, removing the picked faces. Returns an error message, or null. */
  private applyShell(feature: Feature): string | null {
    const { values, errors } = resolveParams(feature);
    if (errors.thickness) return `Wall thickness: ${errors.thickness}`;
    const picks = (feature.picks ?? []).filter((p) => p.ref.kind === "face");
    if (picks.length === 0) return "Click the face to leave open (usually the top). The rest of the part becomes walls.";
    const partIds = [...new Set(picks.map((p) => p.partId))];
    if (partIds.length > 1) return "Shell works on one part at a time. Remove the faces picked on the other part.";
    const part = this.parts.find((p) => p.id === partIds[0]);
    if (!part) return "The part these faces were on no longer exists. Edit this feature and pick the faces again.";

    let faces: Face[];
    try {
      faces = findPickedFaces(part.shape, picks);
    } catch (e) {
      return describeError(e, "Couldn't find the picked faces.");
    }
    const failed =
      "Couldn't hollow this part. Try thinner walls — rounded corners and thin areas must be thicker than the walls.";
    let shape: Shape3D;
    try {
      shape = part.shape.shell(values.thickness, (f) => f.inList(faces));
    } catch {
      return failed;
    } finally {
      faces.forEach((f) => f.delete());
    }
    // A hollowed part must be valid, lighter than before, and no bigger than before. (With walls
    // thicker than the part, OpenCascade can "succeed" with a strange inside-out solid.)
    if (!isValidSolid(shape) || !shrankWithin(part.shape, shape)) {
      shape.delete();
      return failed;
    }
    part.shape.delete();
    part.shape = shape;
    part.featureIds.push(feature.id);
    return null;
  }

  /** Fillet or chamfer the picked edges of their parts. Returns an error message, or null. */
  private applyEdgeFeature(feature: Feature): string | null {
    const def = FEATURE_DEFS[feature.type];
    const { values, errors } = resolveParams(feature);
    const badParam = def.params.find((p) => errors[p.key]);
    if (badParam) return `${badParam.label}: ${errors[badParam.key]}`;
    const picks = feature.picks ?? [];
    if (picks.length === 0) return "Click the edges (or faces) you want to " + (feature.type === "fillet" ? "round." : "bevel.");
    const size = feature.type === "fillet" ? values.radius : values.distance;

    // Apply part by part; picks remember which part they're on.
    const partIds = [...new Set(picks.map((p) => p.partId))];
    for (const partId of partIds) {
      const part = this.parts.find((p) => p.id === partId);
      if (!part) return "The part these edges were on no longer exists. Edit this feature and pick the edges again.";
    }
    const results: { part: BuiltPart; shape: Shape3D }[] = [];
    try {
      for (const partId of partIds) {
        const part = this.parts.find((p) => p.id === partId)!;
        const chosen = findPickedEdges(part.shape, picks.filter((p) => p.partId === partId));
        const pick = (e: Edge) => (chosen.some((c) => c.isSame(e)) ? size : null);
        const failed =
          feature.type === "fillet"
            ? "Couldn't round these edges. Try a smaller radius — it has to fit on the faces next to each edge."
            : "Couldn't bevel these edges. Try a smaller distance — it has to fit on the faces next to each edge.";
        let shape: Shape3D;
        try {
          shape = feature.type === "fillet" ? part.shape.fillet(pick) : part.shape.chamfer(pick);
        } catch {
          throw new Error(failed);
        } finally {
          chosen.forEach((c) => c.delete());
        }
        // OpenCascade sometimes "succeeds" with a broken solid when the size is too big.
        if (!isValidSolid(shape)) {
          shape.delete();
          throw new Error(failed);
        }
        results.push({ part, shape });
      }
    } catch (e) {
      results.forEach((r) => r.shape.delete());
      return describeError(e, `Couldn't make this ${def.label.toLowerCase()}.`);
    }
    for (const { part, shape } of results) {
      part.shape.delete();
      part.shape = shape;
      part.featureIds.push(feature.id);
    }
    return null;
  }

  /** Checks every part is a sound, closed solid. */
  check(quality: MeshQuality): CheckResult {
    const oc = getOC();
    const tol = MESH_TOLERANCES[quality];
    return {
      overlaps: this.findOverlaps(),
      parts: this.parts.map((p) => {
        let geometryValid: boolean | null = null;
        try {
          const analyzer = new oc.BRepCheck_Analyzer(p.shape.wrapped, true, false, false);
          geometryValid = analyzer.IsValid();
          analyzer.delete();
        } catch {
          geometryValid = null;
        }
        let exactVolume: number | null = null;
        try {
          exactVolume = measureVolume(p.shape);
        } catch {
          exactVolume = null;
        }
        const m = p.shape.mesh(tol);
        const mesh = analyzeMesh(m.vertices, m.triangles);
        // Measuring wall thickness only makes sense on a closed surface.
        const thinnest = mesh.watertight ? estimateThickness(m.vertices, m.triangles) : null;
        return { partId: p.id, name: p.name, geometryValid, exactVolume, mesh, thinnest };
      }),
    };
  }

  /** Separate parts that occupy the same space (they would clash). */
  private findOverlaps(): NonNullable<CheckResult["overlaps"]> {
    const found: NonNullable<CheckResult["overlaps"]> = [];
    const boxes = this.parts.map((p) => boundsOf(p.shape));
    const apart = (a: Bounds, b: Bounds) => [0, 1, 2].some((i) => a[1][i] < b[0][i] || b[1][i] < a[0][i]);
    for (let i = 0; i < this.parts.length; i++) {
      for (let j = i + 1; j < this.parts.length; j++) {
        if (apart(boxes[i], boxes[j])) continue;
        try {
          const common = this.parts[i].shape.intersect(this.parts[j].shape);
          const volume = measureVolume(common);
          common.delete();
          if (volume > 1e-3) found.push({ a: this.parts[i].name, b: this.parts[j].name, volume });
        } catch {
          // couldn't tell; say nothing rather than guess
        }
      }
    }
    return found;
  }

  /** One binary STL containing the chosen parts (all parts when the list is empty). */
  exportStl(partIds: string[], quality: MeshQuality): ExportResult {
    const tol = MESH_TOLERANCES[quality];
    const chosen = partIds.length ? this.parts.filter((p) => partIds.includes(p.id)) : this.parts;
    if (chosen.length === 0) throw new Error("There's nothing to export yet.");
    const meshes = chosen.map((p) => {
      const m = p.shape.mesh(tol);
      return { vertices: m.vertices, triangles: withoutDegenerateTriangles(m.vertices, m.triangles) };
    });
    const triangleCount = meshes.reduce((n, m) => n + m.triangles.length / 3, 0);
    const names = chosen.map((p) => p.name).join(", ");
    return { stl: writeBinaryStl(meshes, `PartSmith export: ${names}`), triangleCount };
  }

  /** Measure one or two picked edges/faces: lengths, areas, round sizes, and the gap and angle between them. */
  measure(picks: TopoPick[]): Measurement {
    const found: { item: MeasuredItem; shape: Edge | Face }[] = [];
    for (const pick of picks.slice(0, 2)) {
      const part = this.parts.find((p) => p.id === pick.partId);
      if (!part) continue;
      const bounds = boundsOf(part.shape);
      const size = Math.hypot(bounds[1][0] - bounds[0][0], bounds[1][1] - bounds[0][1], bounds[1][2] - bounds[0][2]);
      const item = describePick(pick.ref);
      if (pick.ref.kind === "edge") {
        const edges = part.shape.edges;
        const [i] = matchRefs([pick.ref], edges.map((e) => edgeRefOf(e, bounds)), size);
        if (i === null) continue;
        const edge = edges[i];
        edges.forEach((e, j) => j !== i && e.delete());
        item.length = measureLength(edge);
        if (pick.ref.curve === "CIRCLE") {
          const c = circleThrough3D(take(edge.pointAt(0)), take(edge.pointAt(1 / 3)), take(edge.pointAt(2 / 3)));
          if (c) Object.assign(item, { radius: c.radius, centre: c.centre });
        }
        found.push({ item, shape: edge });
      } else {
        const faces = part.shape.faces;
        const [i] = matchRefs([pick.ref], faces.map((f) => faceRefOf(f, bounds)), size);
        if (i === null) continue;
        const face = faces[i];
        faces.forEach((f, j) => j !== i && f.delete());
        item.area = measureArea(face);
        if (pick.ref.surface === "CYLINDRE") {
          // A round face's size comes from one of its round edges.
          for (const e of face.edges) {
            if (!item.radius && e.geomType === "CIRCLE") {
              const c = circleThrough3D(take(e.pointAt(0)), take(e.pointAt(1 / 3)), take(e.pointAt(2 / 3)));
              if (c) Object.assign(item, { radius: c.radius, centre: c.centre });
            }
            e.delete();
          }
        }
        found.push({ item, shape: face });
      }
    }
    const result: Measurement = { items: found.map((f) => f.item) };
    if (found.length === 2) {
      try {
        result.distance = measureDistanceBetween(found[0].shape, found[1].shape);
      } catch {
        // leave it out
      }
      const angle = angleBetween(picks[0].ref, picks[1].ref);
      if (angle !== null) result.angle = angle;
      const [a, b] = found.map((f) => f.item.centre);
      if (a && b) result.centreDistance = centreGap(a, b);
    }
    found.forEach((f) => f.shape.delete());
    return result;
  }

  /** One 3MF file with each chosen part as a separate, named object. */
  export3mf(partIds: string[], quality: MeshQuality, title: string, colours: Record<string, string> = {}): ThreeMfResult {
    const tol = MESH_TOLERANCES[quality];
    const chosen = partIds.length ? this.parts.filter((p) => partIds.includes(p.id)) : this.parts;
    if (chosen.length === 0) throw new Error("There's nothing to export yet.");
    const meshes = chosen.map((p) => {
      const m = p.shape.mesh(tol);
      return { name: p.name, vertices: m.vertices, triangles: withoutDegenerateTriangles(m.vertices, m.triangles), colour: colours[p.id] };
    });
    const bytes = write3mf(meshes, title);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return { data, triangleCount: meshes.reduce((n, m) => n + m.triangles.length / 3, 0) };
  }

  /**
   * One STEP file containing the chosen parts (all when the list is empty).
   * STEP keeps the exact shape — curves stay curves — which is what most
   * manufacturers (machining, sheet metal, injection moulding) ask for.
   */
  async exportStep(partIds: string[], colours: Record<string, string> = {}): Promise<StepResult> {
    const chosen = partIds.length ? this.parts.filter((p) => partIds.includes(p.id)) : this.parts;
    if (chosen.length === 0) throw new Error("There's nothing to export yet.");
    const blob = exportSTEP(
      // Without a colour the STEP writer would make every part red, so uncoloured parts get the usual grey.
      chosen.map((p) => ({ shape: p.shape, name: p.name, color: colours[p.id] ?? DEFAULT_PART_COLOUR })),
      { unit: "mm" },
    );
    return { step: await blob.arrayBuffer(), partCount: chosen.length };
  }

  get partCount(): number {
    return this.parts.length;
  }

  dispose(): void {
    this.disposeParts();
  }

  private meshPart(p: BuiltPart): PartMesh {
    const faces = p.shape.mesh(MESH_TOLERANCES.display);
    const edges = p.shape.meshEdges(MESH_TOLERANCES.display);
    // Describe each face and edge so picks can be found again after the next rebuild.
    const bounds = boundsOf(p.shape);
    const faceById = new Map<number, Face[]>();
    for (const f of p.shape.faces) faceById.set(f.hashCode, [...(faceById.get(f.hashCode) ?? []), f]);
    const edgeById = new Map<number, Edge[]>();
    for (const e of p.shape.edges) edgeById.set(e.hashCode, [...(edgeById.get(e.hashCode) ?? []), e]);
    const unknownFace: FaceRef = { kind: "face", surface: "UNKNOWN", center: [0, 0, 0], normal: [0, 0, 0] };
    const unknownEdge: EdgeRef = { kind: "edge", curve: "UNKNOWN", a: [0, 0, 0], b: [0, 0, 0], mid: [0, 0, 0] };
    const faceRefs = faces.faceGroups.map((g) => {
      const f = faceById.get(g.faceId)?.shift();
      if (!f) return unknownFace;
      const ref = faceRefOf(f, bounds);
      f.delete();
      return ref;
    });
    const edgeRefs = edges.edgeGroups.map((g) => {
      const e = edgeById.get(g.edgeId)?.shift();
      if (!e) return unknownEdge;
      const ref = edgeRefOf(e, bounds);
      e.delete();
      return ref;
    });
    for (const list of [...faceById.values(), ...edgeById.values()]) list.forEach((x) => x.delete());
    return {
      id: p.id,
      name: p.name,
      featureIds: [...p.featureIds],
      vertices: Float32Array.from(faces.vertices),
      normals: Float32Array.from(faces.normals),
      triangles: Uint32Array.from(faces.triangles),
      faceGroups: faces.faceGroups,
      lines: Float32Array.from(edges.lines),
      edgeGroups: edges.edgeGroups,
      faceRefs,
      edgeRefs,
    };
  }

  private disposeParts(): void {
    for (const p of this.parts) {
      try {
        p.shape.delete();
      } catch {
        // already freed
      }
    }
    this.parts = [];
    for (const t of this.tools.values()) {
      try {
        t.shape.delete();
      } catch {
        // already freed
      }
    }
    this.tools.clear();
  }
}
