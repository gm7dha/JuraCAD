/**
 * Editing operations on a sketch. Each takes a sketch and returns a new one
 * (never modifying the input), already solved so every constraint holds.
 * When an edit can't be satisfied it returns an `error` in plain English and
 * the caller keeps the old sketch.
 */
import { evaluate } from "../model/expr";
import { startingLength } from "../model/units";
import { analyzeSketch, solveSketch } from "./solver";
import {
  isDimension,
  ORIGIN_ID,
  type ConstraintType,
  type RelationType,
  type SketchArc,
  type SketchCircle,
  type SketchConstraint,
  type SketchCurve,
  type SketchData,
  type SketchLine,
} from "./types";

let counter = 0;
export function sketchId(prefix: string): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** What a click landed on, so new geometry can attach to it. */
export type Snap = { kind: "point"; id: string } | { kind: "origin" } | { kind: "curve"; id: string };

export interface Placed {
  x: number;
  y: number;
  snap?: Snap | null;
}

export interface EditResult {
  sketch: SketchData;
  error?: string;
}

// ---------------------------------------------------------------------------
// Lookups and measurements

export function pointPos(s: SketchData, id: string): [number, number] {
  if (id === ORIGIN_ID) return [0, 0];
  const p = s.points.find((q) => q.id === id);
  if (!p) throw new Error(`missing point ${id}`);
  return [p.x, p.y];
}

export const curveById = (s: SketchData, id: string) => s.curves.find((c) => c.id === id);
export const isPointId = (s: SketchData, id: string) => id === ORIGIN_ID || s.points.some((p) => p.id === id);

export function radiusOf(s: SketchData, c: SketchCircle | SketchArc): number {
  if (c.type === "circle") return c.radius;
  const [cx, cy] = pointPos(s, c.center);
  const [sx, sy] = pointPos(s, c.start);
  return Math.hypot(sx - cx, sy - cy);
}

/** Points that define a curve (moving these moves the curve). */
export function curvePoints(c: SketchCurve): string[] {
  return c.type === "line" ? [c.p1, c.p2] : c.type === "circle" ? [c.center] : [c.center, c.start, c.end];
}

function lineDir(s: SketchData, l: SketchLine): [number, number] {
  const [ax, ay] = pointPos(s, l.p1);
  const [bx, by] = pointPos(s, l.p2);
  return [bx - ax, by - ay];
}

/** The value a dimension currently measures (mm, or degrees for angles). */
export function measure(s: SketchData, c: SketchConstraint): number {
  const [a, b] = c.refs;
  switch (c.type) {
    case "distance": {
      const [px, py] = pointPos(s, a);
      const [qx, qy] = pointPos(s, b);
      return Math.hypot(qx - px, qy - py);
    }
    case "length": {
      const [dx, dy] = lineDir(s, curveById(s, a) as SketchLine);
      return Math.hypot(dx, dy);
    }
    case "horizontalDistance":
    case "verticalDistance": {
      const k = c.type === "horizontalDistance" ? 0 : 1;
      return Math.abs(pointPos(s, b)[k] - pointPos(s, a)[k]);
    }
    case "radius":
      return radiusOf(s, curveById(s, a) as SketchCircle | SketchArc);
    case "diameter":
      return 2 * radiusOf(s, curveById(s, a) as SketchCircle | SketchArc);
    case "angle": {
      const [ux, uy] = lineDir(s, curveById(s, a) as SketchLine);
      const [wx, wy] = lineDir(s, curveById(s, b) as SketchLine);
      return Math.abs((Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy) * 180) / Math.PI);
    }
    case "pointLineDistance": {
      const [px, py] = pointPos(s, a);
      const l = curveById(s, b) as SketchLine;
      const [ax, ay] = pointPos(s, l.p1);
      const [dx, dy] = lineDir(s, l);
      return Math.abs(dx * (py - ay) - dy * (px - ax)) / (Math.hypot(dx, dy) || 1);
    }
    default:
      return 0;
  }
}

/** Round a measured value for display / as a starting dimension value. */
export function roundValue(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

// ---------------------------------------------------------------------------
// Checked solving

/** Lines, circles and arcs that have shrunk to (almost) nothing. */
function collapsed(s: SketchData): Set<string> {
  const out = new Set<string>();
  for (const c of s.curves) {
    if (c.type === "line") {
      const [dx, dy] = lineDir(s, c);
      if (Math.hypot(dx, dy) < 1e-6) out.add(c.id);
    } else if (radiusOf(s, c) < 1e-6) out.add(c.id);
  }
  return out;
}

/**
 * Solve a changed sketch and check the result is sensible: every constraint
 * met, nothing squashed to zero size and (optionally) the change actually
 * pins something down rather than repeating what's already set.
 */
function checkedSolve(before: SketchData, changed: SketchData, what: string, mustReduceFreedom: boolean): EditResult {
  const r = solveSketch(changed);
  if (!r.ok) return { sketch: before, error: `${what} would conflict with the sketch's other constraints or dimensions.` };
  const was = collapsed(before);
  if ([...collapsed(r.sketch)].some((id) => !was.has(id))) {
    return { sketch: before, error: `${what} would shrink a line or circle to nothing.` };
  }
  if (mustReduceFreedom && analyzeSketch(r.sketch).freedom >= analyzeSketch(before).freedom) {
    return { sketch: before, error: `That's already set by other constraints or dimensions, so ${what.toLowerCase()} isn't needed.` };
  }
  return { sketch: r.sketch };
}

// ---------------------------------------------------------------------------
// Adding geometry

export function settle(sketch: SketchData): EditResult {
  const r = solveSketch(sketch);
  return { sketch: r.sketch };
}

/** Resolve a placed point into a point id, adding the point and any snap constraint. */
export function placePoint(s: SketchData, p: Placed): { sketch: SketchData; id: string } {
  if (p.snap?.kind === "point" && isPointId(s, p.snap.id) && p.snap.id !== ORIGIN_ID) return { sketch: s, id: p.snap.id };
  const id = sketchId("p");
  const points = [...s.points, { id, x: p.x, y: p.y }];
  const constraints = [...s.constraints];
  if (p.snap?.kind === "origin" || (p.snap?.kind === "point" && p.snap.id === ORIGIN_ID)) {
    constraints.push({ id: sketchId("c"), type: "coincident", refs: [id, ORIGIN_ID] });
  } else if (p.snap?.kind === "curve") {
    const c = curveById(s, p.snap.id);
    if (c) constraints.push({ id: sketchId("c"), type: c.type === "line" ? "pointOnLine" : "pointOnCircle", refs: [id, c.id] });
  }
  return { sketch: { ...s, points, constraints }, id };
}

export function addPoint(s: SketchData, at: Placed): EditResult & { pointId: string } {
  const placed = placePoint(s, at);
  const sketch = {
    ...placed.sketch,
    points: placed.sketch.points.map((p) => (p.id === placed.id ? { ...p, standalone: true } : p)),
  };
  return { ...settle(sketch), pointId: placed.id };
}

export interface LineOptions {
  construction?: boolean;
  /** Add an automatic horizontal or vertical constraint (inferred while drawing). */
  orientation?: "horizontal" | "vertical" | null;
}

export function addLine(s: SketchData, a: Placed, b: Placed, opts: LineOptions = {}): EditResult & { lineId: string; endId: string } {
  const pa = placePoint(s, a);
  const pb = placePoint(pa.sketch, b);
  if (pa.id === pb.id) return { sketch: s, lineId: "", endId: pa.id, error: "A line needs two different ends." };
  const id = sketchId("l");
  const line: SketchLine = { id, type: "line", p1: pa.id, p2: pb.id, construction: !!opts.construction };
  const constraints = [...pb.sketch.constraints];
  if (opts.orientation) constraints.push({ id: sketchId("c"), type: opts.orientation, refs: [id] });
  const result = settle({ ...pb.sketch, curves: [...pb.sketch.curves, line], constraints });
  return { ...result, lineId: id, endId: pb.id };
}

/** Rectangle from two opposite corners, with horizontal and vertical sides. */
export function addRectangle(s: SketchData, a: Placed, b: Placed, construction = false): EditResult & { lineIds: string[] } {
  if (Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6) {
    return { sketch: s, lineIds: [], error: "Drag out a rectangle with some width and height." };
  }
  const c1 = placePoint(s, a);
  const c3 = placePoint(c1.sketch, b);
  let sk = c3.sketch;
  const c2 = sketchId("p");
  const c4 = sketchId("p");
  sk = { ...sk, points: [...sk.points, { id: c2, x: b.x, y: a.y }, { id: c4, x: a.x, y: b.y }] };
  const corners = [c1.id, c2, c3.id, c4];
  const lineIds = corners.map(() => sketchId("l"));
  const lines: SketchLine[] = corners.map((p, i) => ({
    id: lineIds[i],
    type: "line",
    p1: p,
    p2: corners[(i + 1) % 4],
    construction,
  }));
  const constraints: SketchConstraint[] = [
    { id: sketchId("c"), type: "horizontal", refs: [lineIds[0]] },
    { id: sketchId("c"), type: "vertical", refs: [lineIds[1]] },
    { id: sketchId("c"), type: "horizontal", refs: [lineIds[2]] },
    { id: sketchId("c"), type: "vertical", refs: [lineIds[3]] },
  ];
  const result = settle({ ...sk, curves: [...sk.curves, ...lines], constraints: [...sk.constraints, ...constraints] });
  return { ...result, lineIds };
}

export function addCircle(s: SketchData, center: Placed, radius: number, construction = false): EditResult & { circleId: string } {
  if (radius < 1e-6) return { sketch: s, circleId: "", error: "Drag out the circle to give it a size." };
  const c = placePoint(s, center);
  const id = sketchId("k");
  const circle: SketchCircle = { id, type: "circle", center: c.id, radius, construction };
  return { ...settle({ ...c.sketch, curves: [...c.sketch.curves, circle] }), circleId: id };
}

/** Centre of the circle through three points, or null if they're in a line. */
export function circleThrough(a: [number, number], b: [number, number], c: [number, number]): [number, number] | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  return [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
  ];
}

/** Three-point arc: from `start` to `end`, bulging through `through` (like Onshape). */
export function addArc(s: SketchData, start: Placed, end: Placed, through: { x: number; y: number }, construction = false): EditResult & { arcId: string } {
  const centre = circleThrough([start.x, start.y], [through.x, through.y], [end.x, end.y]);
  if (!centre) return { sketch: s, arcId: "", error: "Those three points are in a line — move the last one to bend the arc." };
  const ps = placePoint(s, start);
  const pe = placePoint(ps.sketch, end);
  if (ps.id === pe.id) return { sketch: s, arcId: "", error: "An arc needs two different ends." };
  const cid = sketchId("p");
  let sk: SketchData = { ...pe.sketch, points: [...pe.sketch.points, { id: cid, x: centre[0], y: centre[1] }] };
  // Arcs run anticlockwise from start to end; swap if the user went clockwise.
  const cross = (end.x - start.x) * (through.y - start.y) - (end.y - start.y) * (through.x - start.x);
  const [from, to] = cross < 0 ? [ps.id, pe.id] : [pe.id, ps.id];
  const id = sketchId("a");
  const arc: SketchArc = { id, type: "arc", center: cid, start: from, end: to, construction };
  sk = { ...sk, curves: [...sk.curves, arc] };
  return { ...settle(sk), arcId: id };
}

// ---------------------------------------------------------------------------
// Deleting and construction

/** Delete curves, points and/or constraints, tidying up anything left dangling. */
export function deleteItems(s: SketchData, ids: string[]): SketchData {
  const gone = new Set(ids);
  const curves = s.curves.filter((c) => !gone.has(c.id));
  // Keep points still used by a curve, or that the user placed on their own (unless deleted).
  const used = new Set(curves.flatMap(curvePoints));
  const points = s.points.filter((p) => !gone.has(p.id) && (used.has(p.id) || (p.standalone && !gone.has(p.id))));
  const alive = new Set<string>([ORIGIN_ID, ...points.map((p) => p.id), ...curves.map((c) => c.id)]);
  const constraints = s.constraints.filter((c) => !gone.has(c.id) && c.refs.every((r) => alive.has(r)));
  return solveSketch({ points, curves, constraints }).sketch;
}

export function toggleConstruction(s: SketchData, curveIds: string[]): SketchData {
  const ids = new Set(curveIds);
  const targets = s.curves.filter((c) => ids.has(c.id));
  if (!targets.length) return s;
  const makeConstruction = targets.some((c) => !c.construction);
  return { ...s, curves: s.curves.map((c) => (ids.has(c.id) ? { ...c, construction: makeConstruction } : c)) };
}

// ---------------------------------------------------------------------------
// Constraints

export type RelationTool =
  | "coincident"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "tangent"
  | "concentric"
  | "midpoint"
  | "symmetric"
  | "fix";

export const RELATION_LABELS: Record<RelationTool, string> = {
  coincident: "Coincident",
  horizontal: "Horizontal",
  vertical: "Vertical",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  equal: "Equal",
  tangent: "Tangent",
  concentric: "Concentric",
  midpoint: "Midpoint",
  symmetric: "Symmetric",
  fix: "Fix",
};

/** What to select for each relation, in plain English. */
export const RELATION_HINTS: Record<RelationTool, string> = {
  coincident: "Select two points, or a point and a line, circle or arc",
  horizontal: "Select one or more lines, or two points",
  vertical: "Select one or more lines, or two points",
  parallel: "Select two or more lines",
  perpendicular: "Select two lines",
  equal: "Select two or more lines, or two or more circles/arcs",
  tangent: "Select a line and a circle/arc, or two circles/arcs",
  concentric: "Select two circles or arcs",
  midpoint: "Select a point and a line",
  symmetric: "Select two points (or two lines, circles or arcs) and then the line they mirror across",
  fix: "Select the points or shapes to hold in place",
};

const isLine = (c?: SketchCurve): c is SketchLine => c?.type === "line";

/** Where a point lands when mirrored across a line. */
export function mirrorPoint(s: SketchData, axis: SketchLine, [x, y]: [number, number]): [number, number] {
  const [ax, ay] = pointPos(s, axis.p1);
  const [bx, by] = pointPos(s, axis.p2);
  const dx = bx - ax, dy = by - ay;
  const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1);
  const fx = ax + t * dx, fy = ay + t * dy;
  return [2 * fx - x, 2 * fy - y];
}
const isRound = (c?: SketchCurve): c is SketchCircle | SketchArc => c?.type === "circle" || c?.type === "arc";

function relationConstraints(s: SketchData, tool: RelationTool, sel: string[]): SketchConstraint[] | string {
  const pts = sel.filter((id) => isPointId(s, id));
  const crv = sel.map((id) => curveById(s, id)).filter((c): c is SketchCurve => !!c);
  const lines = crv.filter(isLine);
  const rounds = crv.filter(isRound);
  const mk = (type: RelationType, refs: string[], extra?: number[]): SketchConstraint => ({ id: sketchId("c"), type, refs, extra });
  const only = (n: number) => sel.length === n;

  switch (tool) {
    case "coincident":
      if (only(2) && pts.length === 2) return [mk("coincident", pts)];
      if (only(2) && pts.length === 1 && crv.length === 1)
        return [mk(isLine(crv[0]) ? "pointOnLine" : "pointOnCircle", [pts[0], crv[0].id])];
      break;
    case "horizontal":
    case "vertical":
      if (lines.length && lines.length === sel.length) return lines.map((l) => mk(tool, [l.id]));
      if (only(2) && pts.length === 2) return [mk(tool, pts)];
      break;
    case "parallel":
      if (lines.length >= 2 && lines.length === sel.length) return lines.slice(1).map((l) => mk("parallel", [lines[0].id, l.id]));
      break;
    case "perpendicular":
      if (only(2) && lines.length === 2) return [mk("perpendicular", [lines[0].id, lines[1].id])];
      break;
    case "equal":
      if (lines.length >= 2 && lines.length === sel.length) return lines.slice(1).map((l) => mk("equal", [lines[0].id, l.id]));
      if (rounds.length >= 2 && rounds.length === sel.length) return rounds.slice(1).map((r) => mk("equal", [rounds[0].id, r.id]));
      break;
    case "tangent":
      if (only(2) && lines.length === 1 && rounds.length === 1) return [mk("tangent", [lines[0].id, rounds[0].id])];
      if (only(2) && rounds.length === 2) {
        const [c1, c2] = rounds;
        const [ax, ay] = pointPos(s, c1.center);
        const [bx, by] = pointPos(s, c2.center);
        const d = Math.hypot(bx - ax, by - ay);
        const internal = d < Math.max(radiusOf(s, c1), radiusOf(s, c2));
        return [mk("tangent", [c1.id, c2.id], [internal ? 1 : 0])];
      }
      break;
    case "concentric":
      if (only(2) && rounds.length === 2) return [mk("concentric", [rounds[0].id, rounds[1].id])];
      break;
    case "midpoint":
      if (only(2) && pts.length === 1 && lines.length === 1) return [mk("midpoint", [pts[0], lines[0].id])];
      break;
    case "symmetric": {
      // The mirror line is the last thing selected.
      const axis = curveById(s, sel[sel.length - 1]);
      if (!isLine(axis) || sel.length !== 3) break;
      const rest = sel.slice(0, 2);
      if (rest.every((id) => isPointId(s, id))) return [mk("symmetric", [rest[0], rest[1], axis.id])];
      const [c1, c2] = rest.map((id) => curveById(s, id));
      if (isLine(c1) && isLine(c2)) {
        // Pair each end with the end of the other line nearest its mirror image.
        const [a1, a2] = [c1.p1, c1.p2].map((id) => mirrorPoint(s, axis, pointPos(s, id)));
        const d = (p: [number, number], id: string) => Math.hypot(p[0] - pointPos(s, id)[0], p[1] - pointPos(s, id)[1]);
        const straight = d(a1, c2.p1) + d(a2, c2.p2) <= d(a1, c2.p2) + d(a2, c2.p1);
        return [mk("symmetric", [c1.p1, straight ? c2.p1 : c2.p2, axis.id]), mk("symmetric", [c1.p2, straight ? c2.p2 : c2.p1, axis.id])];
      }
      if (isRound(c1) && isRound(c2)) return [mk("symmetric", [c1.center, c2.center, axis.id]), mk("equal", [c1.id, c2.id])];
      break;
    }
    case "fix": {
      const ids = new Set([...pts.filter((p) => p !== ORIGIN_ID), ...crv.flatMap(curvePoints).filter((p) => p !== ORIGIN_ID)]);
      if (ids.size) return [...ids].map((p) => mk("fix", [p], pointPos(s, p)));
      break;
    }
  }
  return RELATION_HINTS[tool] + ".";
}

/** Apply a relation (horizontal, tangent, …) to the selection. */
export function applyRelation(s: SketchData, tool: RelationTool, selection: string[]): EditResult {
  const made = relationConstraints(s, tool, selection);
  if (typeof made === "string") return { sketch: s, error: made };
  return checkedSolve(s, { ...s, constraints: [...s.constraints, ...made] }, RELATION_LABELS[tool], true);
}

// ---------------------------------------------------------------------------
// Dimensions

/** Work out which dimension to add for the selection (like Onshape's single Dimension tool). */
export function dimensionFor(s: SketchData, sel: string[]): { type: ConstraintType; refs: string[]; extra?: number[] } | string {
  const pts = sel.filter((id) => isPointId(s, id));
  const crv = sel.map((id) => curveById(s, id)).filter((c): c is SketchCurve => !!c);
  if (sel.length === 1 && crv.length === 1) {
    const c = crv[0];
    if (c.type === "line") return { type: "length", refs: [c.id] };
    if (c.type === "circle") return { type: "diameter", refs: [c.id] };
    return { type: "radius", refs: [c.id] };
  }
  if (sel.length === 2 && pts.length === 2) return { type: "distance", refs: pts };
  if (sel.length === 2 && pts.length === 1 && crv.length === 1 && isLine(crv[0])) return { type: "pointLineDistance", refs: [pts[0], crv[0].id] };
  if (sel.length === 2 && crv.length === 2 && isLine(crv[0]) && isLine(crv[1])) {
    const [ux, uy] = lineDir(s, crv[0]);
    const [wx, wy] = lineDir(s, crv[1]);
    const cross = ux * wy - uy * wx;
    const lens = Math.hypot(ux, uy) * Math.hypot(wx, wy) || 1;
    if (Math.abs(cross) / lens < 1e-3) return { type: "pointLineDistance", refs: [crv[1].p1, crv[0].id] };
    return { type: "angle", refs: [crv[0].id, crv[1].id], extra: [Math.sign(cross) || 1] };
  }
  return "Select a line, circle or arc — or two points, a point and a line, or two lines — to dimension.";
}

/** Add a dimension for the selection, starting at its current size. */
export function addDimension(
  s: SketchData,
  sel: string[],
  labelOffset: { x: number; y: number } = { x: 0, y: 0 },
): EditResult & { dimensionId: string } {
  const spec = dimensionFor(s, sel);
  if (typeof spec === "string") return { sketch: s, error: spec, dimensionId: "" };
  const id = sketchId("d");
  const draft: SketchConstraint = { id, ...spec, value: "0", labelOffset };
  // Lengths start in the design's units (angles in degrees).
  draft.value = draft.type === "angle" ? roundValue(measure(s, draft)) : startingLength(measure(s, draft));
  const r = checkedSolve(s, { ...s, constraints: [...s.constraints, draft] }, "A dimension", true);
  if (r.error) {
    return {
      sketch: s,
      error: "That's already fully set by other constraints or dimensions, so another dimension would over-define it.",
      dimensionId: "",
    };
  }
  return { sketch: r.sketch, dimensionId: id };
}

/** Change a dimension's value (any expression, e.g. "20", "10 + 5", "1 in"). */
export function setDimensionValue(s: SketchData, id: string, value: string): EditResult {
  const c = s.constraints.find((x) => x.id === id);
  if (!c || !isDimension(c)) return { sketch: s, error: "That dimension no longer exists." };
  const r = evaluate(value);
  if (!r.ok) return { sketch: s, error: r.error };
  if (c.type !== "angle" && r.value <= 0 && c.type !== "pointLineDistance") return { sketch: s, error: "Must be more than 0." };
  if (c.type === "pointLineDistance" && r.value < 0) return { sketch: s, error: "Can't be negative." };
  const solved = checkedSolve(s, { ...s, constraints: s.constraints.map((x) => (x.id === id ? { ...x, value } : x)) }, "That value", false);
  if (solved.error) return { sketch: s, error: "The sketch can't take that value with its other constraints." };
  return solved;
}

export function moveDimensionLabel(s: SketchData, id: string, labelOffset: { x: number; y: number }): SketchData {
  return { ...s, constraints: s.constraints.map((c) => (c.id === id ? { ...c, labelOffset } : c)) };
}

// ---------------------------------------------------------------------------
// Dragging

export function dragPoint(s: SketchData, pointId: string, x: number, y: number): SketchData {
  const r = solveSketch(s, { drag: { pointId, x, y } });
  return r.ok ? r.sketch : s;
}

/** Move a whole curve by (dx, dy) from its position in `start`. */
export function dragCurve(start: SketchData, curveId: string, dx: number, dy: number): SketchData {
  const c = curveById(start, curveId);
  if (!c) return start;
  const r = solveSketch(start, { moveRigid: { pointIds: curvePoints(c).filter((p) => p !== ORIGIN_ID), dx, dy } });
  return r.ok ? r.sketch : start;
}

/** Drag a circle's rim to resize it. */
export function dragCircleRim(start: SketchData, circleId: string, radius: number): SketchData {
  if (radius <= 1e-6) return start;
  const r = solveSketch(start, { resize: { circleId, radius } });
  return r.ok ? r.sketch : start;
}
