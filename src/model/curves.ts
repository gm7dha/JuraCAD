/**
 * Curve features (Onshape's Helix, Projected curve, Bridging curve, Composite curve, Fit spline and Intersection
 * curve): their names, settings, what they use (for Delete with dependents) and the pure maths — a helix's
 * height / turns / pitch and a bridging curve's control points. The geometry itself is made in kernel/curves.ts.
 */
import type { TopoPick } from "../geometry/topoRef";
import type { SketchPlane } from "../sketch/planes";
import type { BridgeMatch, CurveDef, CurveKind, Feature, GeomPick } from "./types";

type Vec3 = [number, number, number];

export interface CurveKindInfo {
  kind: CurveKind;
  /** Shown in the toolbar and the dialog's title. */
  label: string;
  /** Names: "Helix 1", "Fit spline 2"… */
  prefix: string;
  description: string;
}

export const CURVE_KINDS: readonly CurveKindInfo[] = [
  { kind: "helix", label: "Helix", prefix: "Helix", description: "A curve winding round an axis, a round face or a round edge, like a spring or a thread. Sweep a circle along it for a spring." },
  { kind: "projected", label: "Projected curve", prefix: "Projected curve", description: "A sketch's lines and curves pressed onto faces straight across from the sketch, or where two sketches' curves meet when each is pushed out from its own plane." },
  { kind: "bridge", label: "Bridging curve", prefix: "Bridging curve", description: "A smooth curve joining two points or the ends of two edges, setting off and arriving in the same direction as them." },
  { kind: "composite", label: "Composite curve", prefix: "Composite curve", description: "Part edges and other curves joined end to end into one curve, for a sweep or a pattern to follow." },
  { kind: "fitSpline", label: "Fit spline", prefix: "Fit spline", description: "A smooth curve through points you click (corners, edge middles, sketch points, mate connectors), in order." },
  { kind: "intersection", label: "Intersection curve", prefix: "Intersection curve", description: "The curve where two faces meet, or where faces are cut by a plane." },
  { kind: "offset", label: "Offset curve", prefix: "Offset curve", description: "Edges of a face moved a set distance across the face (into it, or out with Other way). Click a face for its whole outline, or edges and the face to move them across." },
  { kind: "isocline", label: "Isocline", prefix: "Isocline", description: "Where a face slopes at a set angle to a direction (like a draft check): 0° is where the face is upright to it." },
  { kind: "trim", label: "Trim curve", prefix: "Trim curve", description: "A curve cut back to where it first meets a face, a plane or another curve." },
];

export function curveKindInfo(kind: CurveKind | undefined): CurveKindInfo {
  return CURVE_KINDS.find((k) => k.kind === kind) ?? CURVE_KINDS[0];
}

/** The next free name for a curve of a kind ("Helix 1", "Helix 2"…). */
export function curveName(features: readonly Pick<Feature, "name">[], kind: CurveKind): string {
  const prefix = curveKindInfo(kind).prefix;
  const used = new Set(features.map((f) => f.name));
  let n = 1;
  while (used.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

/** A new curve's settings (a helix starts round the Z axis). */
export function newCurveDef(kind: CurveKind): CurveDef {
  if (kind === "helix") return { kind, around: "axis", axis: { p: [0, 0, 0], dir: [0, 0, 1], axis: "z" } };
  if (kind === "projected") return { kind, project: "faces" };
  if (kind === "fitSpline") return { kind, points: [] };
  if (kind === "composite") return { kind, curves: [] };
  if (kind === "bridge") return { kind, picking: "from" };
  if (kind === "isocline") return { kind, axis: { p: [0, 0, 0], dir: [0, 0, 1], axis: "z" } };
  if (kind === "trim") return { kind, curves: [] };
  return { kind };
}

/** The size boxes a curve shows. */
export function curveParamKeys(def: CurveDef | undefined): string[] {
  if (!def) return [];
  if (def.kind === "helix") {
    const by = def.helixBy ?? "heightTurns";
    const onFace = def.around === "face";
    const keys: string[] = [];
    // Round a face the helix runs the face's whole height, unless it's set by turns and pitch.
    if (by !== "turnsPitch" && !onFace) keys.push("height");
    if (by !== "heightPitch") keys.push("turns");
    if (by !== "heightTurns") keys.push("pitch");
    if (def.around !== "face" && !def.start) keys.push("diameter");
    keys.push("startAngle");
    if (!onFace) keys.push("taper");
    return keys;
  }
  if (def.kind === "bridge") return ["bulge"];
  if (def.kind === "offset") return ["distance"];
  if (def.kind === "isocline") return ["angle"];
  return [];
}

/** A helix's height, turns and pitch from the two typed (or the face's height). */
export function helixSizes(by: CurveDef["helixBy"], v: { height?: number; turns?: number; pitch?: number }, faceHeight?: number): { height: number; turns: number; pitch: number } | string {
  const mode = by ?? "heightTurns";
  const height = mode === "turnsPitch" ? (v.turns ?? 0) * (v.pitch ?? 0) : faceHeight ?? v.height ?? 0;
  if (!(height > 1e-9)) return faceHeight !== undefined && mode !== "turnsPitch" ? "That round face has no height to wind up." : "The height must be more than 0.";
  let turns: number;
  let pitch: number;
  if (mode === "heightPitch") {
    pitch = v.pitch ?? 0;
    if (!(pitch > 1e-9)) return "The pitch must be more than 0.";
    turns = height / pitch;
  } else {
    turns = v.turns ?? 0;
    if (!(turns > 1e-9)) return "Give it more than 0 turns.";
    pitch = mode === "turnsPitch" ? v.pitch ?? 0 : height / turns;
  }
  if (turns > 500) return "That's more than 500 turns. Use fewer turns (or a bigger pitch).";
  return { height, turns, pitch };
}

/** The length of a helix of radius `r` (no taper), `turns` turns rising `pitch` per turn. */
export function helixLength(r: number, turns: number, pitch: number): number {
  return turns * Math.hypot(2 * Math.PI * r, pitch);
}

// --- Bridging curve -------------------------------------------------------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));

/** One end of a bridging curve: the point, and (to match) the direction the curve should run there and the bend (curvature vector). */
export interface BridgeEnd {
  p: Vec3;
  /** Direction of travel along the bridge at this end (start: setting off; end: arriving). */
  t?: Vec3;
  /** Curvature vector there (1/radius towards the centre of the bend), square to `t`. */
  k?: Vec3;
  match: BridgeMatch;
}

/**
 * The control points of a Bézier curve joining two ends: a straight line when neither end is matched, a cubic
 * when directions are matched, a quintic when a bend (curvature) is too. `bulge` (1 = usual) stretches the
 * handles: more makes the curve swing out further before it turns.
 */
export function bridgePoints(a: BridgeEnd, b: BridgeEnd, bulge = 1): Vec3[] | string {
  const chord = sub(b.p, a.p);
  const c = len(chord);
  if (!(c > 1e-6)) return "The two ends are at the same place. Pick two different points.";
  const ma = a.t ? a.match : "position";
  const mb = b.t ? b.match : "position";
  if (ma === "position" && mb === "position") return [a.p, b.p];
  const degree = ma === "curvature" || mb === "curvature" ? 5 : 3;
  // Handle length: a third of the way (cubic) or a quarter (quintic), times the bulge.
  const h = (bulge * c) / (degree === 3 ? 3 : 4);
  const dirA = ma === "position" ? unit(chord) : unit(a.t!);
  const dirB = mb === "position" ? unit(chord) : unit(b.t!);
  const p1 = add(a.p, scale(dirA, h));
  const q1 = sub(b.p, scale(dirB, h));
  if (degree === 3) return [a.p, p1, q1, b.p];
  // Quintic: B'(0) = 5(P1 − P0), B''(0) = 20(P2 − 2P1 + P0). With B''(0) square to B'(0) the curvature vector is
  // B''(0) / |B'(0)|², so P2 = 2P1 − P0 + 25h²K / 20 (and K = 0 leaves the end straight, as a cubic would).
  const bend = (k: Vec3 | undefined, t: Vec3, m: BridgeMatch): Vec3 => {
    if (m !== "curvature" || !k) return [0, 0, 0];
    // Only the part square to the direction bends it.
    return sub(k, scale(t, dot(k, t)));
  };
  const p2 = add(sub(scale(p1, 2), a.p), scale(bend(a.k, dirA, ma), (25 * h * h) / 20));
  const q2 = add(sub(scale(q1, 2), b.p), scale(bend(b.k, dirB, mb), (25 * h * h) / 20));
  return [a.p, p1, p2, q2, q1, b.p];
}

/** A point of a Bézier curve (de Casteljau). */
export function bezierPoint(points: readonly Vec3[], t: number): Vec3 {
  let pts = points.map((p) => [...p] as Vec3);
  while (pts.length > 1) pts = pts.slice(1).map((p, i) => add(scale(pts[i], 1 - t), scale(p, t)));
  return pts[0];
}

/** First and second derivatives of a Bézier curve at an end (t = 0 or 1). */
export function bezierEndDerivatives(points: readonly Vec3[], end: 0 | 1): { d1: Vec3; d2: Vec3 } {
  const n = points.length - 1;
  const P = end === 0 ? points : [...points].reverse();
  const d1 = scale(sub(P[1], P[0]), n * (end === 0 ? 1 : -1));
  const d2 = n >= 2 ? scale(add(sub(P[2], scale(P[1], 2)), P[0]), n * (n - 1)) : [0, 0, 0];
  return { d1, d2: d2 as Vec3 };
}

/** The curvature vector of a curve from its first and second derivatives. */
export function curvatureVector(d1: Vec3, d2: Vec3): Vec3 {
  const s2 = dot(d1, d1);
  if (s2 < 1e-24) return [0, 0, 0];
  // (d2 − (d2·T)T) / |d1|²
  const t = unit(d1);
  return scale(sub(d2, scale(t, dot(d2, t))), 1 / s2);
}

// --- Fit spline -----------------------------------------------------------------------------------

/** Why a fit spline can't go through these points (null: it can). */
export function fitSplineProblem(points: readonly Vec3[], closed: boolean): string | null {
  if (points.length < 2) return "Click at least two points for the spline to go through.";
  if (closed && points.length < 3) return "A closed spline needs at least three points.";
  for (let i = 1; i < points.length; i++) if (len(sub(points[i], points[i - 1])) < 1e-6) return `Points ${i} and ${i + 1} are at the same place. Take one out.`;
  if (closed && len(sub(points[0], points[points.length - 1])) < 1e-6) return "The last point is the first one again: tick Closed instead.";
  return null;
}

// --- What a curve uses (Delete with dependents) and reading files ---------------------------------

/** The features and parts a curve can't do without, and the lists it may lose some of. */
export function curveUses(f: Pick<Feature, "curve" | "sketchRef" | "picks">): { features: string[]; parts: string[]; curveList?: string[] } {
  const def = f.curve;
  const features: string[] = [];
  const parts: string[] = [];
  if (!def) return { features, parts };
  const geom = (g: GeomPick | undefined) => {
    if (!g) return;
    if (g.pick) parts.push(g.pick.partId);
    if (g.sketchPoint) features.push(g.sketchPoint.sketch);
    if (g.sketchLine) features.push(g.sketchLine.sketch);
    if (g.connector) features.push(g.connector);
    if (g.curve) features.push(g.curve);
  };
  if (def.kind === "helix") {
    if (def.around === "face") {
      if (def.on) parts.push(def.on.partId);
    } else {
      geom(def.axis);
      geom(def.start);
    }
  }
  if (def.kind === "projected" && def.project === "sketches" && def.sketch2) features.push(def.sketch2);
  if (def.kind === "bridge") {
    geom(def.from);
    geom(def.to);
  }
  if (def.kind === "fitSpline") for (const g of def.points ?? []) geom(g);
  if (def.kind === "isocline") geom(def.axis);
  // A trim curve can't do without the curve it trims, nor the curve it's cut back to.
  if (def.kind === "trim") features.push(...(def.curves ?? []).slice(0, 2));
  if ((def.kind === "intersection" || def.kind === "trim") && def.plane?.kind === "face") {
    if (def.plane.planeRef) features.push(def.plane.planeRef);
    if (def.plane.face) parts.push(def.plane.face.partId);
  }
  return { features, parts, ...(def.kind === "composite" && def.curves?.length ? { curveList: def.curves } : {}) };
}

const KINDS = new Set<string>(CURVE_KINDS.map((k) => k.kind));
const MATCHES = new Set<string>(["position", "tangent", "curvature"]);

/** A curve's settings from a file (odd values dropped), or null. The readers are document.ts's. */
export function parseCurveDef(
  raw: unknown,
  read: { geom: (x: unknown) => GeomPick | null; pick: (x: unknown) => TopoPick | null; plane: (x: unknown) => SketchPlane | null },
): CurveDef | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.kind !== "string" || !KINDS.has(c.kind)) return null;
  const out: CurveDef = { kind: c.kind as CurveKind };
  if (c.around === "axis" || c.around === "face") out.around = c.around;
  const axis = read.geom(c.axis);
  if (axis) out.axis = axis;
  const start = read.geom(c.start);
  if (start) out.start = start;
  const on = read.pick(c.on);
  if (on) out.on = on;
  if (c.helixBy === "heightTurns" || c.helixBy === "heightPitch" || c.helixBy === "turnsPitch") out.helixBy = c.helixBy;
  if (c.clockwise === true) out.clockwise = true;
  if (c.flip === true) out.flip = true;
  if (c.project === "faces" || c.project === "sketches") out.project = c.project;
  if (typeof c.sketch2 === "string") out.sketch2 = c.sketch2;
  const from = read.geom(c.from);
  if (from) out.from = from;
  const to = read.geom(c.to);
  if (to) out.to = to;
  if (typeof c.matchFrom === "string" && MATCHES.has(c.matchFrom)) out.matchFrom = c.matchFrom as BridgeMatch;
  if (typeof c.matchTo === "string" && MATCHES.has(c.matchTo)) out.matchTo = c.matchTo as BridgeMatch;
  if (c.flipFrom === true) out.flipFrom = true;
  if (c.flipTo === true) out.flipTo = true;
  if (Array.isArray(c.curves)) out.curves = c.curves.filter((x): x is string => typeof x === "string");
  if (Array.isArray(c.points)) out.points = c.points.map(read.geom).filter((x): x is GeomPick => x !== null).slice(0, 500);
  if (c.closed === true) out.closed = true;
  const plane = c.plane ? read.plane(c.plane) : null;
  if (plane) out.plane = plane;
  return out;
}

/** Is this feature a curve (Helix, Fit spline…)? */
export const isCurve = (f: Pick<Feature, "type"> | undefined): boolean => f?.type === "curve";

/** A one-line description of a curve, for the Claude extension's feature list. */
export function describeCurve(f: Pick<Feature, "curve" | "params">): string {
  const def = f.curve;
  if (!def) return "curve";
  const info = curveKindInfo(def.kind);
  if (def.kind === "fitSpline") return `fit spline through ${def.points?.length ?? 0} points${def.closed ? " (closed)" : ""}`;
  if (def.kind === "helix") {
    const by = def.helixBy ?? "heightTurns";
    const bits = [by !== "turnsPitch" && def.around !== "face" ? `height ${f.params.height}` : null, by !== "heightPitch" ? `${f.params.turns} turns` : null, by !== "heightTurns" ? `pitch ${f.params.pitch}` : null].filter(Boolean);
    return `helix round ${def.around === "face" ? "a round face or edge" : "an axis"}, ${bits.join(", ")}${def.clockwise ? ", clockwise" : ""}`;
  }
  return info.label.toLowerCase();
}
