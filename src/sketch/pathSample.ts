/**
 * A sketch's lines and arcs, joined end to end, as a path in 3D you can walk
 * along by distance — for Curve pattern (copies spaced evenly along a path).
 */
import { pointPos } from "./ops";
import { planeFrame, toWorld, type SketchPlane, type Vec3 } from "./planes";
import { chainOf } from "./tools";
import type { SketchArc, SketchData, SketchLine } from "./types";

export interface PathWalk {
  length: number;
  closed: boolean;
  /** The point and direction (unit) `d` mm along the path. */
  at: (d: number) => { point: Vec3; tangent: Vec3 };
}

/** The path, or a plain-English reason it can't be used. */
export function walkPath(plane: SketchPlane, data: SketchData): PathWalk | string {
  const curves = data.curves.filter((c): c is SketchLine | SketchArc => (c.type === "line" || c.type === "arc") && !c.construction);
  if (curves.length === 0) return "The path sketch has no lines or arcs.";
  // Start from an open end when there is one.
  const ends = new Map<string, number>();
  for (const c of curves) for (const p of c.type === "line" ? [c.p1, c.p2] : [c.start, c.end]) ends.set(p, (ends.get(p) ?? 0) + 1);
  const start = curves.find((c) => (c.type === "line" ? [c.p1, c.p2] : [c.start, c.end]).some((p) => ends.get(p) === 1)) ?? curves[0];
  let { steps, closed } = chainOf(data, start);
  if (steps.length !== curves.length) return "The path must be one connected run of lines and arcs, with no branches.";
  // Begin at the open end (the chain may have been found starting from the far end of the first curve).
  if (!closed && ends.get(steps[0].from) !== 1) steps = [...steps].reverse().map((s) => ({ ...s, from: s.to, to: s.from }));
  const frame = planeFrame(plane);
  const pts: [number, number][] = [];
  for (const st of steps) {
    const a = pointPos(data, st.from);
    const b = pointPos(data, st.to);
    if (st.curve.type === "line") {
      if (!pts.length) pts.push(a);
      pts.push(b);
      continue;
    }
    const [cx, cy] = pointPos(data, st.curve.center);
    const r = Math.hypot(a[0] - cx, a[1] - cy);
    const a0 = Math.atan2(a[1] - cy, a[0] - cx);
    let a1 = Math.atan2(b[1] - cy, b[0] - cx);
    // Arcs are stored anticlockwise from start to end; walking from end to start goes the other way.
    const forward = st.from === st.curve.start;
    if (forward) while (a1 <= a0) a1 += 2 * Math.PI;
    else while (a1 >= a0) a1 -= 2 * Math.PI;
    const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 90)));
    if (!pts.length) pts.push(a);
    for (let i = 1; i <= n; i++) {
      const t = a0 + ((a1 - a0) * i) / n;
      pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
  }
  const world = pts.map(([x, y]) => toWorld(frame, x, y));
  const cum = [0];
  for (let i = 1; i < world.length; i++) cum.push(cum[i - 1] + Math.hypot(...(world[i].map((v, k) => v - world[i - 1][k]) as Vec3)));
  const length = cum[cum.length - 1];
  if (!(length > 1e-9)) return "The path has no length.";
  const at = (d: number) => {
    const t = Math.max(0, Math.min(length, d));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < t) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const f = (t - cum[i - 1]) / seg;
    const p0 = world[i - 1];
    const p1 = world[i];
    const dir = p1.map((v, k) => v - p0[k]) as Vec3;
    const l = Math.hypot(...dir) || 1;
    return { point: p0.map((v, k) => v + dir[k] * f) as Vec3, tangent: dir.map((v) => v / l) as Vec3 };
  };
  return { length, closed, at };
}

/** Where copies go: `count` evenly spaced points from the start (to the end, or once round a closed path). */
export function pathStations(walk: PathWalk, count: number): number[] {
  const n = Math.max(2, Math.round(count));
  const step = walk.closed ? walk.length / n : walk.length / (n - 1);
  return Array.from({ length: n }, (_, i) => i * step);
}
