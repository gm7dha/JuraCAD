/**
 * Building blocks for library designs: sketches whose dimensions are the
 * design's variables, and the Feature records the app's own dialogs make
 * (so an inserted design edits exactly like one drawn by hand).
 */
import { defaultParams } from "../model/features";
import { setCurrentScope, type Scope } from "../model/expr";
import type { ExtrudeEnd, Feature, FeatureType, Operation } from "../model/types";
import { buildSketch } from "../mcp/sketchShapes";
import { analyzeSketch, solveSketch } from "../sketch/solver";
import { filletCorner } from "../sketch/tools";
import { sketchId } from "../sketch/ops";
import type { SketchPlane } from "../sketch/planes";
import { ORIGIN_ID, type SketchConstraint, type SketchData, type SketchLine } from "../sketch/types";
import { signed, type Ex } from "./ex";
import type { Pt } from "./fingers";

const isZeroText = (t: string) => t.trim() === "0";

/** Dimensions holding a point at (x, y) measured from the sketch origin. */
function placeFromOrigin(pointId: string, x: Ex, y: Ex): SketchConstraint[] {
  return ([x, y] as const).map((e, k): SketchConstraint => {
    if (isZeroText(e.t)) return { id: sketchId("c"), type: k === 0 ? "vertical" : "horizontal", refs: [pointId, ORIGIN_ID] };
    const { sign, text } = signed(e);
    return { id: sketchId("d"), type: k === 0 ? "horizontalDistance" : "verticalDistance", refs: [ORIGIN_ID, pointId], value: text, extra: [sign] };
  });
}

/**
 * A closed outline through the points, every corner dimensioned from the
 * origin with the design's variables (so the sketch is fully defined and
 * follows them). A corner exactly at the origin is joined to it.
 */
export function outlineSketch(pts: Pt[], scope: Scope): SketchData {
  setCurrentScope(scope);
  const ids = pts.map((p) => (isZeroText(p[0].t) && isZeroText(p[1].t) ? ORIGIN_ID : sketchId("p")));
  const points = pts.flatMap((p, i) => (ids[i] === ORIGIN_ID ? [] : [{ id: ids[i], x: p[0].v, y: p[1].v }]));
  const curves: SketchLine[] = pts.map((_, i) => ({ id: sketchId("l"), type: "line", p1: ids[i], p2: ids[(i + 1) % ids.length], construction: false }));
  const constraints = pts.flatMap((p, i) => (ids[i] === ORIGIN_ID ? [] : placeFromOrigin(ids[i], p[0], p[1])));
  const r = solveSketch({ points, curves, constraints });
  if (!r.ok) throw new Error("The outline's dimensions don't agree.");
  return r.sketch;
}

/** A sketch from shapes ("rectangle", "circle", …; see mcp/sketchShapes.ts), sizes given as expressions. */
export function shapesSketch(shapes: unknown[], scope: Scope): SketchData {
  return buildSketch(shapes, scope).data;
}

/** Round every corner of the sketch's rectangles (sketch fillets, radius as an expression). */
export function roundCorners(s: SketchData, radius: Ex, scope: Scope): SketchData {
  if (!(radius.v > 0)) return s;
  setCurrentScope(scope);
  const corners = new Set<string>();
  for (const c of s.curves) if (c.type === "line" && !c.construction) [c.p1, c.p2].forEach((p) => p !== ORIGIN_ID && corners.add(p));
  let out = s;
  for (const p of corners) {
    const r = filletCorner(out, p, radius.t);
    if (r.error) throw new Error(`Couldn't round the corners: ${r.error}`);
    out = r.sketch;
  }
  return out;
}

/** How many ways the sketch could still move (0 = fully defined). */
export const freedomOf = (s: SketchData) => analyzeSketch(s).freedom;

const base = (id: string, name: string, type: FeatureType, operation: Operation, params: Record<string, string> = {}): Feature => ({
  id,
  name,
  type,
  operation,
  suppressed: false,
  params: { ...defaultParams(type), ...params },
});

export function sketchFeature(id: string, name: string, plane: SketchPlane, data: SketchData): Feature {
  return { ...base(id, name, "sketch", "new"), params: {}, sketch: { plane, data } };
}

export function extrudeFeature(
  id: string,
  name: string,
  sketchRef: string,
  opts: { depth?: Ex; operation: Operation; end?: ExtrudeEnd; flip?: boolean },
): Feature {
  return {
    ...base(id, name, "extrude", opts.operation, opts.depth ? { depth: opts.depth.t } : {}),
    sketchRef,
    extrude: { end: opts.end ?? "blind", flip: !!opts.flip },
    // As the Extrude dialog makes them now: separate pieces are separate parts, cuts reach every part.
    apart: true,
    intersectAll: true,
  };
}

/** Move / copy a part (a copy is a new part, named by this feature's id). */
export function copyFeature(id: string, name: string, partId: string, move: { dx?: Ex; dy?: Ex; dz?: Ex }): Feature {
  const params: Record<string, string> = {};
  for (const k of ["dx", "dy", "dz"] as const) if (move[k]) params[k] = move[k]!.t;
  return { ...base(id, name, "transform", "add", params), transform: { partId, axis: "z", about: "centre", copy: true } };
}

export function linearPatternFeature(id: string, name: string, sources: string[], axis: "x" | "y" | "z", count: Ex, spacing: Ex): Feature {
  return { ...base(id, name, "linearPattern", "add", { count: count.t, spacing: spacing.t }), pattern: { sources, axis, flip: false } };
}

export function circularPatternFeature(id: string, name: string, sources: string[], count: Ex): Feature {
  return { ...base(id, name, "circularPattern", "add", { count: count.t, angle: "360" }), pattern: { sources, axis: "z", flip: false } };
}
