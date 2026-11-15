/**
 * Variable fillet (Onshape's Fillet › Variable): radii set at points on the picked edges — at their ends or part
 * way along — with the fillet changing smoothly (or in straight steps) between them. Pure: the shared rules for
 * the dialog, the engine (src/kernel/variableFillet.ts), the Claude extension and file reading.
 *
 * A point belongs to a picked edge by that pick's part and middle (`ref.mid`), so it goes when the pick goes, and
 * its place is a share of the edge's length from the end the pick calls `a`. On a rebuild the engine finds which
 * end of the edge as it is now lies nearer the pick's `a`, so a radius set at one end stays at that end even when
 * OpenCascade hands the edge back the other way round.
 */
import { sameRef, type EdgeRef, type TopoPick, type Vec3 } from "../geometry/topoRef";
import type { Feature, FilletRadiusPoint, VariableFillet } from "./types";

/** Is this pick the edge the point is on? */
export function pointOnPick(pick: TopoPick, p: Pick<FilletRadiusPoint, "part" | "edge">): boolean {
  if (pick.partId !== p.part || pick.ref.kind !== "edge") return false;
  const m = pick.ref.mid;
  return Math.abs(m[0] - p.edge[0]) < 1e-6 && Math.abs(m[1] - p.edge[1]) < 1e-6 && Math.abs(m[2] - p.edge[2]) < 1e-6;
}

/** The picked edge a point is on (none once that edge has been taken out of the fillet). */
export function radiusPointPick(picks: readonly TopoPick[] | undefined, p: FilletRadiusPoint): TopoPick | undefined {
  return (picks ?? []).find((k) => pointOnPick(k, p));
}

/** The feature without points on edges no longer picked (the same object when there are none). */
export function tidyRadiusPoints<T extends Pick<Feature, "picks" | "variableFillet">>(f: T): T {
  const vf = f.variableFillet;
  if (!vf) return f;
  const points = vf.points.filter((p) => radiusPointPick(f.picks, p));
  return points.length === vf.points.length ? f : { ...f, variableFillet: { ...vf, points } };
}

const isVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** Variable fillet settings from a file (anything odd dropped); undefined when there are none. */
export function parseVariableFillet(raw: unknown): VariableFillet | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const points: FilletRadiusPoint[] = [];
  for (const q of Array.isArray(r.points) ? r.points : []) {
    if (!q || typeof q !== "object") continue;
    const p = q as Record<string, unknown>;
    if (typeof p.part !== "string" || !isVec(p.edge) || typeof p.at !== "number" || !Number.isFinite(p.at) || typeof p.radius !== "string") continue;
    points.push({ part: p.part, edge: [p.edge[0], p.edge[1], p.edge[2]], at: Math.min(1, Math.max(0, p.at)), radius: p.radius.slice(0, 200) });
  }
  return { points, ...(r.straight === true ? { straight: true as const } : {}) };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: Vec3, b: Vec3) => Math.hypot(...sub(a, b));

/** How near an end (a share of the length) a click counts as on that end. */
export const END_SNAP = 0.15;

/**
 * Where a click lies along a picked edge, as a share of its length from `a`: exact on a straight edge; on a
 * curved one only its ends are known here (null in between).
 */
export function clickShare(ref: EdgeRef, at: Vec3): number | null {
  const chord = dist(ref.a, ref.b);
  if (ref.curve === "LINE" && chord > 1e-9) {
    const t = dot(sub(at, ref.a), sub(ref.b, ref.a)) / (chord * chord);
    return Math.min(1, Math.max(0, t));
  }
  if (chord < 1e-9) return null; // a whole circle: its two ends are the same point
  const da = dist(at, ref.a);
  const db = dist(at, ref.b);
  const reach = END_SNAP * 2 * Math.max(chord, dist(ref.a, ref.mid) + dist(ref.mid, ref.b));
  if (Math.min(da, db) > reach) return null;
  return da <= db ? 0 : 1;
}

/** A point's place in space, where it can be told without the part's geometry (straight edges, and any edge's ends). */
export function radiusPointAt(ref: EdgeRef, at: number): Vec3 | null {
  if (ref.curve === "LINE") return [0, 1, 2].map((i) => ref.a[i] + (ref.b[i] - ref.a[i]) * at) as Vec3;
  if (at <= 1e-9) return ref.a;
  if (at >= 1 - 1e-9) return ref.b;
  if (Math.abs(at - 0.5) < 1e-9) return ref.mid;
  return null;
}

/**
 * A click on an edge the variable fillet already rounds puts a radius point there (snapped to the nearer end when
 * within `END_SNAP` of it; the middle of a curved edge when it can't be told). Null when the click is for the plain
 * pick toggle (not a variable fillet, a face, a new edge). The same feature when there's a point there already.
 */
export function clickRadiusPoint(f: Feature, pick: TopoPick): Feature | null {
  if (f.type !== "fillet" || !f.variableFillet || pick.ref.kind !== "edge") return null;
  // The same edge as picked (by the usual tolerance: the part may have moved a little since it was picked).
  const own = (f.picks ?? []).find((k) => k.partId === pick.partId && k.ref.kind === "edge" && sameRef(k.ref, pick.ref));
  if (!own || own.ref.kind !== "edge") return null;
  let share = pick.at ? clickShare(own.ref, pick.at) : null;
  if (share === null) share = 0.5;
  else if (share < END_SNAP) share = 0;
  else if (share > 1 - END_SNAP) share = 1;
  else share = Math.round(share * 100) / 100;
  return addRadiusPoint(f, own, share);
}

/** A new point on a picked edge (the main radius to start with); the same feature if there's one there already. */
export function addRadiusPoint(f: Feature, pick: TopoPick, at: number): Feature {
  if (pick.ref.kind !== "edge") return f;
  const vf = f.variableFillet ?? { points: [] };
  const mid = pick.ref.mid;
  const here = vf.points.some((p) => pointOnPick(pick, p) && Math.abs(p.at - at) < 0.02);
  if (here) return f;
  const point: FilletRadiusPoint = { part: pick.partId, edge: [mid[0], mid[1], mid[2]], at, radius: f.params.radius ?? "2" };
  return { ...f, variableFillet: { ...vf, points: [...vf.points, point] } };
}

/** Points in the order the dialog lists them: by picked edge, then along it. */
export function pointsByEdge(f: Pick<Feature, "picks" | "variableFillet">): { point: FilletRadiusPoint; index: number; edge: number }[] {
  const picks = f.picks ?? [];
  return (f.variableFillet?.points ?? [])
    .map((point, index) => ({ point, index, edge: picks.findIndex((k) => pointOnPick(k, point)) }))
    .filter((x) => x.edge >= 0)
    .sort((x, y) => x.edge - y.edge || x.point.at - y.point.at);
}

/** "start", "end" or "40% along", for the dialog's list. */
export function shareWords(at: number): string {
  if (at <= 1e-9) return "start";
  if (at >= 1 - 1e-9) return "end";
  return `${Math.round(at * 100)}% along`;
}

export class VariableFilletError extends Error {}

/**
 * The radii along one run of edges the fillet goes round as one (OpenCascade's contour), as (u, r) with u = a share
 * of the run's length (0…1): the points given, plus `main` at an end with no point (a closed run's ends are one
 * place: a point at either sets both). Sorted; two different radii at the same place are refused.
 */
export function runRadii(points: readonly { u: number; r: number }[], main: number, closed: boolean): { u: number; r: number }[] {
  const out = [...points].sort((a, b) => a.u - b.u);
  const merged: { u: number; r: number }[] = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.u - p.u) < 1e-6) {
      if (Math.abs(last.r - p.r) > 1e-9) throw new VariableFilletError("Two different radii are set at the same place on an edge (where two edges meet, both ends count). Give them the same radius, or remove one.");
      continue;
    }
    merged.push({ u: Math.min(1, Math.max(0, p.u)), r: p.r });
  }
  const atStart = merged.length && merged[0].u < 1e-6 ? merged[0] : null;
  const atEnd = merged.length && merged[merged.length - 1].u > 1 - 1e-6 ? merged[merged.length - 1] : null;
  if (closed) {
    if (atStart && atEnd && Math.abs(atStart.r - atEnd.r) > 1e-9)
      throw new VariableFilletError("This edge goes all the way round, so its start and end are the same place: give them the same radius.");
    const seam = atStart?.r ?? atEnd?.r ?? main;
    if (!atStart) merged.unshift({ u: 0, r: seam });
    if (!atEnd) merged.push({ u: 1, r: seam });
  } else {
    if (!atStart) merged.unshift({ u: 0, r: main });
    if (!atEnd) merged.push({ u: 1, r: main });
  }
  return merged;
}

/**
 * The radius at u along a run: straight between the points, or a smooth curve through them that never goes past
 * the radii either side (a monotone cubic, Fritsch–Carlson), so it can't grow bigger than any radius typed.
 */
export function radiusAt(radii: readonly { u: number; r: number }[], u: number, straight: boolean): number {
  const n = radii.length;
  if (n === 0) return 0;
  if (n === 1 || u <= radii[0].u) return radii[0].r;
  if (u >= radii[n - 1].u) return radii[n - 1].r;
  let k = 0;
  while (k < n - 2 && u > radii[k + 1].u) k++;
  const a = radii[k];
  const b = radii[k + 1];
  const h = b.u - a.u;
  const t = (u - a.u) / h;
  if (straight || n === 2) return a.r + (b.r - a.r) * t;
  const slope = (i: number) => (radii[i + 1].r - radii[i].r) / (radii[i + 1].u - radii[i].u);
  const tangent = (i: number): number => {
    if (i === 0) return slope(0);
    if (i === n - 1) return slope(n - 2);
    const s0 = slope(i - 1);
    const s1 = slope(i);
    if (s0 * s1 <= 0) return 0;
    return (2 * s0 * s1) / (s0 + s1); // harmonic mean: stays monotone
  };
  const m0 = tangent(k) * h;
  const m1 = tangent(k + 1) * h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a.r + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * b.r + (t3 - t2) * m1;
}

/** Samples put between points so OpenCascade's own smooth curve through them follows `radiusAt`. */
export const SAMPLES_BETWEEN = 6;

/**
 * What OpenCascade is given for one edge of a run that spans u0…u1 of it: (x, r) with x the share of THIS edge
 * (0…1, in the run's direction) — the ends, the points in between, and samples between them (none when the run
 * has only its two end radii: that's a plain straight change, which OpenCascade makes exactly).
 */
export function edgeRadii(radii: readonly { u: number; r: number }[], u0: number, u1: number, straight: boolean): [number, number][] {
  const span = u1 - u0;
  if (!(span > 1e-12)) return [];
  const places = new Set<number>([u0, u1]);
  for (const p of radii) if (p.u > u0 + 1e-9 && p.u < u1 - 1e-9) places.add(p.u);
  const sorted = [...places].sort((a, b) => a - b);
  const all: number[] = [];
  const samples = radii.length > 2 ? SAMPLES_BETWEEN : 0;
  for (let i = 0; i < sorted.length; i++) {
    all.push(sorted[i]);
    if (i === sorted.length - 1) break;
    for (let k = 1; k <= samples; k++) all.push(sorted[i] + ((sorted[i + 1] - sorted[i]) * k) / (samples + 1));
  }
  return all.map((u) => [Math.min(1, Math.max(0, (u - u0) / span)), radiusAt(radii, u, straight)]);
}
